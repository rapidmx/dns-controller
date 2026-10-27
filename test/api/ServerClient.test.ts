import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerClient } from "../../src/api/ServerClient.js";

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`../fixtures/api/v1/${name}.json`, import.meta.url), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ServerClient.handshake", () => {
    let dir: string;
    let tokenFile: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "dns-controller-token-"));
        tokenFile = join(dir, "token");
        writeFileSync(tokenFile, "projected-token\n");
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function client(answer: Response | Error | (() => Promise<Response>)): { c: ServerClient; calls: [string, RequestInit][] } {
        const calls: [string, RequestInit][] = [];
        const fake = async (url: string, init: RequestInit) => {
            calls.push([url, init]);
            if (typeof answer === "function") {
                return answer();
            }
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        };
        return {
            c: new ServerClient({ baseUrl: "http://mail:3000/internal/dns", tokenFile, controllerVersion: "0.1.0", timeoutMs: 1000, fetch: fake }),
            calls,
        };
    }

    it("sends the frozen Handshake shape with the projected token and accepts the server's choice", async () => {
        const { c, calls } = client(jsonResponse(fixture("handshake-result-compatible")));
        expect(await c.handshake()).toEqual({ state: "compatible", apiVersion: "dns.rapidmx.io/v1", serverVersion: "1.0.0-beta.47" });
        const [url, init] = calls[0];
        expect(url).toBe("http://mail:3000/internal/dns/handshake");
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({ Authorization: "Bearer projected-token", "Content-Type": "application/json" });
        expect(JSON.parse(String(init.body))).toEqual(fixture("handshake"));
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("re-reads the token file on every call", async () => {
        const { c, calls } = client(() => Promise.resolve(jsonResponse(fixture("handshake-result-compatible"))));
        await c.handshake();
        writeFileSync(tokenFile, "rotated");
        await c.handshake();
        expect((calls[1][1].headers as Record<string, string>).Authorization).toBe("Bearer rotated");
    });

    it("reports the server's reason when it says the versions are incompatible", async () => {
        const { c } = client(jsonResponse(fixture("handshake-result-incompatible")));
        expect(await c.handshake()).toEqual({
            state: "incompatible",
            reason: "no API version in common: the controller speaks dns.rapidmx.io/v1, the server dns.rapidmx.io/v2",
            serverVersion: "2.0.0",
            serverApiVersions: ["dns.rapidmx.io/v2"],
        });
    });

    it("explains an incompatible answer without a reason", async () => {
        const { c } = client(jsonResponse({ kind: "HandshakeResult", apiVersions: [], compatible: false }));
        expect(await c.handshake()).toEqual({
            state: "incompatible",
            reason: "no API version in common (server: none)",
            serverVersion: "unknown",
            serverApiVersions: [],
        });
        const { c: c2 } = client(jsonResponse({ kind: "HandshakeResult", apiVersions: ["dns.rapidmx.io/v2"], compatible: false }));
        expect(await c2.handshake()).toMatchObject({ reason: "no API version in common (server: dns.rapidmx.io/v2)" });
    });

    it("refuses a 'compatible' answer that selects a version this controller does not speak", async () => {
        const { c } = client(
            jsonResponse({ kind: "HandshakeResult", serverVersion: "2.0.0", apiVersions: ["dns.rapidmx.io/v1", "dns.rapidmx.io/v2"], compatible: true, selected: "dns.rapidmx.io/v2" })
        );
        expect(await c.handshake()).toEqual({
            state: "incompatible",
            reason: "the server selected dns.rapidmx.io/v2, which this controller does not speak (both speak dns.rapidmx.io/v1)",
            serverVersion: "2.0.0",
            serverApiVersions: ["dns.rapidmx.io/v1", "dns.rapidmx.io/v2"],
        });
        const { c: c2 } = client(jsonResponse({ kind: "HandshakeResult", serverVersion: "2.0.0", apiVersions: ["dns.rapidmx.io/v2"], compatible: true }));
        expect(await c2.handshake()).toMatchObject({ reason: "the server selected no version, which this controller does not speak" });
    });

    it("treats a server without the DNS API (404) as incompatible", async () => {
        const { c } = client(new Response("not found", { status: 404 }));
        expect(await c.handshake()).toEqual({ state: "incompatible", reason: "the server has no internal DNS API (404)", serverApiVersions: [] });
    });

    it.each([
        ["not JSON", new Response("<html>", { status: 200 })],
        ["not an object", jsonResponse("x")],
        ["null", jsonResponse(null)],
        ["another kind", jsonResponse({ kind: "Other", compatible: true, apiVersions: [] })],
        ["compatible not boolean", jsonResponse({ kind: "HandshakeResult", compatible: "yes", apiVersions: [] })],
        ["apiVersions not strings", jsonResponse({ kind: "HandshakeResult", compatible: true, apiVersions: [1] })],
    ])("treats a malformed answer (%s) as incompatible", async (_label, response) => {
        const { c } = client(response);
        expect(await c.handshake()).toEqual({
            state: "incompatible",
            reason: "the server's handshake answer was not a HandshakeResult",
            serverApiVersions: [],
        });
    });

    it("reports an error status, a network error or a missing token as unavailable", async () => {
        expect(await client(new Response("", { status: 503 })).c.handshake()).toEqual({ state: "unavailable", error: "HTTP 503" });
        expect(await client(new Response("", { status: 401 })).c.handshake()).toEqual({ state: "unavailable", error: "HTTP 401" });
        expect(await client(new Error("fetch failed")).c.handshake()).toEqual({ state: "unavailable", error: "fetch failed" });
        const rejectsUndefined = client(() => Promise.reject(undefined));
        expect(await rejectsUndefined.c.handshake()).toEqual({ state: "unavailable", error: "undefined" });
        rmSync(tokenFile);
        expect(await client(jsonResponse({})).c.handshake()).toMatchObject({ state: "unavailable", error: expect.stringMatching(/ENOENT/) });
    });

    it("uses the global fetch by default against a real HTTP server", async () => {
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ...(fixture("handshake-result-compatible") as object), echoed: JSON.parse(body).kind }));
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const port = (server.address() as AddressInfo).port;
            const c = new ServerClient({ baseUrl: `http://127.0.0.1:${port}/internal/dns`, tokenFile, controllerVersion: "0.1.0", timeoutMs: 2000 });
            expect(await c.handshake()).toMatchObject({ state: "compatible" });
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
