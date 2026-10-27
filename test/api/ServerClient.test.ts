import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerClient } from "../../src/api/ServerClient.js";
import type { StatusReportV1 } from "../../src/api/v1.js";

function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`../fixtures/api/v1/${name}.json`, import.meta.url), "utf8"));
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Answer = Response | Error | ((init: RequestInit) => Promise<Response>);

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

function client(answer: Answer, timeouts: { timeoutMs?: number; longPollTimeoutMs?: number } = {}): { c: ServerClient; calls: [string, RequestInit][] } {
    const calls: [string, RequestInit][] = [];
    const fake = async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        if (typeof answer === "function") {
            return answer(init);
        }
        if (answer instanceof Error) {
            throw answer;
        }
        return answer;
    };
    return {
        c: new ServerClient({
            baseUrl: "http://mail:3000/internal/dns",
            tokenFile,
            controllerVersion: "0.1.0",
            timeoutMs: timeouts.timeoutMs ?? 1000,
            longPollTimeoutMs: timeouts.longPollTimeoutMs ?? 75000,
            fetch: fake,
        }),
        calls,
    };
}

/** A fetch that answers only when its request is aborted (by a timeout or the caller), the way an unanswered long poll ends. */
function hanging(init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
            reject(init.signal.reason);
        }
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
}

describe("ServerClient.handshake", () => {
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

    it("reports an error status, a refused token, a network error or a missing token as unavailable", async () => {
        expect(await client(new Response("", { status: 503 })).c.handshake()).toEqual({ state: "unavailable", error: "HTTP 503" });
        expect(await client(new Response("", { status: 401 })).c.handshake()).toEqual({
            state: "unavailable",
            error: "the server refused the controller's token (HTTP 401)",
        });
        expect(await client(jsonResponse({ code: "AUTH_PERMISSION_FAILURE" }, 403)).c.handshake()).toEqual({
            state: "unavailable",
            error: "the server refused the controller's token (HTTP 403)",
        });
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
            const c = new ServerClient({
                baseUrl: `http://127.0.0.1:${port}/internal/dns`,
                tokenFile,
                controllerVersion: "0.1.0",
                timeoutMs: 2000,
                longPollTimeoutMs: 2000,
            });
            expect(await c.handshake()).toMatchObject({ state: "compatible" });
        } finally {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe("ServerClient.desiredState", () => {
    it("asks for the whole desired state under /v1 with the projected token, and reads it", async () => {
        const { c, calls } = client(jsonResponse(fixture("desired-state")));
        const outcome = await c.desiredState();
        expect(outcome.state).toBe("ok");
        expect(outcome.state === "ok" && outcome.value.version).toBe(42);
        expect(outcome).not.toHaveProperty("value.futureField");
        const [url, init] = calls[0];
        expect(url).toBe("http://mail:3000/internal/dns/v1/desired-state");
        expect(init.method).toBe("GET");
        expect(init.headers).toMatchObject({ Accept: "application/json", Authorization: "Bearer projected-token" });
        expect(init.body).toBeUndefined();
    });

    it("long-polls with since, re-reading the token", async () => {
        const { c, calls } = client(() => Promise.resolve(jsonResponse(fixture("desired-state"))));
        writeFileSync(tokenFile, "rotated");
        await c.desiredState(41);
        expect(calls[0][0]).toBe("http://mail:3000/internal/dns/v1/desired-state?since=41");
        expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer rotated");
    });

    it("gives a request without since the short timeout and a long poll the long one", async () => {
        const quick = client(hanging, { timeoutMs: 20, longPollTimeoutMs: 60000 });
        expect(await quick.c.desiredState()).toMatchObject({ state: "unavailable", error: expect.stringMatching(/timeout|abort/i) });
        const poll = client(hanging, { timeoutMs: 60000, longPollTimeoutMs: 20 });
        expect(await poll.c.desiredState(42)).toMatchObject({ state: "unavailable", error: expect.stringMatching(/timeout|abort/i) });
    });

    it("ends a long poll when the caller aborts", async () => {
        const { c } = client(hanging);
        const abort = new AbortController();
        const pending = c.desiredState(42, abort.signal);
        abort.abort(new Error("stopping"));
        expect(await pending).toEqual({ state: "unavailable", error: "stopping" });
    });

    it.each([
        ["no /v1 route (a server rolled back)", new Response("not found", { status: 404 }), "the server has no dns.rapidmx.io/v1 DNS API (404)"],
        [
            "a refused apiVersion",
            jsonResponse({ reason: "unsupported_api_version", supported: ["dns.rapidmx.io/v2"] }, 400),
            "the server does not speak dns.rapidmx.io/v1 (it speaks dns.rapidmx.io/v2)",
        ],
        [
            "a refused apiVersion without the list",
            jsonResponse({ reason: "unsupported_api_version" }, 400),
            "the server does not speak dns.rapidmx.io/v1 (it speaks none)",
        ],
        [
            "an answer of another version",
            jsonResponse({ ...(fixture("desired-state") as object), apiVersion: "dns.rapidmx.io/v2" }),
            'unsupported apiVersion "dns.rapidmx.io/v2"; this controller speaks dns.rapidmx.io/v1',
        ],
    ])("sends the controller back to the handshake on %s", async (_label, response, reason) => {
        expect(await client(response).c.desiredState(1)).toEqual({ state: "incompatible", reason });
    });

    it.each([
        ["a refused token", new Response("", { status: 403 }), "the server refused the controller's token (HTTP 403)"],
        ["a server error", new Response("", { status: 503 }), "HTTP 503"],
        ["a refused request", jsonResponse({ reason: "invalid_payload", message: "'since' must be a desired-state version" }, 400), "HTTP 400: invalid_payload: 'since' must be a desired-state version"],
        ["a refusal without a message", jsonResponse({ reason: "invalid_payload" }, 400), "HTTP 400: invalid_payload"],
        ["a refusal without a reason", jsonResponse({ message: "x".repeat(500) }, 400), "HTTP 400"],
        ["a rejection without an error", () => Promise.reject(undefined), "undefined"],
        ["a refusal that is not JSON", new Response("<html>", { status: 400 }), "HTTP 400"],
        ["a network error", new Error("fetch failed"), "fetch failed"],
    ])("reports %s as unavailable", async (_label, answer, error) => {
        expect(await client(answer).c.desiredState()).toEqual({ state: "unavailable", error });
    });

    it("cuts a long refusal message", async () => {
        const outcome = await client(jsonResponse({ reason: "invalid_payload", message: "m".repeat(1000) }, 400)).c.desiredState();
        expect(outcome.state === "unavailable" && outcome.error.length).toBe("HTTP 400: invalid_payload: ".length + 200);
    });

    it("reports an answer that is not JSON, or a malformed state, as invalid", async () => {
        expect(await client(new Response("<html>", { status: 200 })).c.desiredState()).toEqual({ state: "invalid", error: "the answer was not JSON" });
        expect(await client(jsonResponse({ ...(fixture("desired-state") as object), version: "x" })).c.desiredState()).toEqual({
            state: "invalid",
            error: "'version' must be a whole number",
        });
    });

    it("reports a missing token file as unavailable", async () => {
        rmSync(tokenFile);
        expect(await client(jsonResponse(fixture("desired-state"))).c.desiredState()).toMatchObject({ state: "unavailable", error: expect.stringMatching(/ENOENT/) });
    });
});

describe("ServerClient.reportStatus", () => {
    const report = fixture("status-report") as StatusReportV1;

    it("PUTs the report under /v1 with the projected token and accepts a StatusReportResult", async () => {
        const { c, calls } = client(jsonResponse({ apiVersion: "dns.rapidmx.io/v1", kind: "StatusReportResult" }));
        expect(await c.reportStatus(report)).toEqual({ state: "ok", value: { apiVersion: "dns.rapidmx.io/v1", kind: "StatusReportResult" } });
        const [url, init] = calls[0];
        expect(url).toBe("http://mail:3000/internal/dns/v1/status");
        expect(init.method).toBe("PUT");
        expect(init.headers).toMatchObject({ Authorization: "Bearer projected-token", "Content-Type": "application/json" });
        expect(JSON.parse(String(init.body))).toEqual(fixture("status-report"));
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("sends the controller back to the handshake when the server refuses the version or answers in another one", async () => {
        expect(await client(jsonResponse({ reason: "unsupported_api_version", supported: [] }, 400)).c.reportStatus(report)).toEqual({
            state: "incompatible",
            reason: "the server does not speak dns.rapidmx.io/v1 (it speaks none)",
        });
        expect(await client(new Response("", { status: 404 })).c.reportStatus(report)).toMatchObject({ state: "incompatible" });
        expect(await client(jsonResponse({ kind: "StatusReportResult" })).c.reportStatus(report)).toEqual({
            state: "incompatible",
            reason: "unsupported apiVersion undefined; this controller speaks dns.rapidmx.io/v1",
        });
    });

    it("reports a refused report, an error or an answer that is not JSON", async () => {
        expect(await client(jsonResponse({ reason: "invalid_payload", message: "'lease' must say whether ..." }, 400)).c.reportStatus(report)).toEqual({
            state: "unavailable",
            error: "HTTP 400: invalid_payload: 'lease' must say whether ...",
        });
        expect(await client(new Error("fetch failed")).c.reportStatus(report)).toEqual({ state: "unavailable", error: "fetch failed" });
        expect(await client(new Response("ok", { status: 200 })).c.reportStatus(report)).toEqual({ state: "invalid", error: "the answer was not JSON" });
    });
});
