import { InternalApiServer, type InternalRoute } from "../src/InternalApiServer.js";
import { Logger } from "../src/log.js";
import { hasIpv6Loopback } from "./helpers/ipv6.js";

const ipv6: boolean = await hasIpv6Loopback();

const SUBJECT = "system:serviceaccount:rapidmx:mail";

describe("InternalApiServer", () => {
    let server: InternalApiServer;
    let base: string;
    let lines: string[];
    let writable: boolean;
    let verify: ReturnType<typeof vi.fn>;
    let handled: { params: string[]; body?: unknown }[];

    const routes: InternalRoute[] = [
        {
            method: "PUT",
            path: /^\/secrets\/([^/]+)$/,
            kind: "SecretWrite",
            handle: async (request) => {
                handled.push(request);
                return { status: 200, body: { apiVersion: "dns.rapidmx.io/v1", kind: "SecretWriteResult", path: request.params[0] } };
            },
        },
        {
            method: "DELETE",
            path: /^\/secrets\/([^/]+)$/,
            handle: async (request) => {
                handled.push(request);
                if (request.params[0] === "boom") {
                    throw new Error("kube down");
                }
                return { status: 204 };
            },
        },
    ];

    async function start(extra: Partial<ConstructorParameters<typeof InternalApiServer>[0]> = {}): Promise<void> {
        server = new InternalApiServer({
            verifier: { verify },
            subject: SUBJECT,
            gate: { mayWrite: () => writable },
            log: new Logger("debug", (l) => lines.push(l)),
            routes,
            ...extra,
        });
        const port = await server.listen(0, "127.0.0.1");
        base = `http://127.0.0.1:${port}`;
    }

    /** A call with `token` (`null`: no Authorization header). */
    const call = (path: string, init: RequestInit = {}, token: string | null = "server-token"): Promise<Response> =>
        fetch(`${base}${path}`, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers as object) } });

    const put = (path: string, body: string): Promise<Response> => call(path, { method: "PUT", body, headers: { "Content-Type": "application/json" } });

    const logged = () => lines.map((l) => JSON.parse(l));

    beforeEach(() => {
        lines = [];
        writable = true;
        handled = [];
        verify = vi.fn(async (token: string) => {
            if (token === "server-token") {
                return { subject: SUBJECT };
            }
            if (token === "other-token") {
                return { subject: "system:serviceaccount:rapidmx:intruder" };
            }
            throw new Error("the token's signature does not verify");
        });
    });

    afterEach(async () => {
        await server?.close();
    });

    it("serves an authenticated v1 request, handing the route its path parameters and the checked body", async () => {
        await start();
        const response = await put("/v1/secrets/dns-cloudflare", JSON.stringify({ apiVersion: "dns.rapidmx.io/v1", kind: "SecretWrite", values: { a: "b" } }));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({ apiVersion: "dns.rapidmx.io/v1", kind: "SecretWriteResult", path: "dns-cloudflare" });
        expect(handled).toEqual([{ params: ["dns-cloudflare"], body: { apiVersion: "dns.rapidmx.io/v1", kind: "SecretWrite", values: { a: "b" } } }]);
        expect(verify).toHaveBeenCalledWith("server-token");
    });

    it("answers a route without a body, and one without an answer body", async () => {
        await start();
        const response = await call("/v1/secrets/dns-x", { method: "DELETE" });
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
        expect(handled).toEqual([{ params: ["dns-x"] }]);
    });

    it.each([
        ["no Authorization header", null],
        ["a token that does not verify", "forged"],
        ["another ServiceAccount's token", "other-token"],
    ])("refuses %s with the same 403, before looking at the route", async (_label, token) => {
        await start();
        for (const path of ["/v1/secrets/x", "/v2/secrets/x", "/nothing"]) {
            const response = await call(path, { method: "PUT", body: "{}" }, token);
            expect(response.status).toBe(403);
            expect(await response.json()).toEqual({ reason: "forbidden" });
        }
        expect(handled).toEqual([]);
        const refusals = logged().filter((e) => e.msg === "internal_api_refused");
        expect(refusals.length).toBe(3);
        expect(lines.join("\n")).not.toContain("forged");
    });

    it("refuses an Authorization header that is not a bearer token without verifying anything", async () => {
        await start();
        expect((await fetch(`${base}/v1/secrets/x`, { method: "DELETE", headers: { Authorization: "Basic dXNlcjpwYXNz" } })).status).toBe(403);
        expect(verify).not.toHaveBeenCalled();
        expect(logged()[0]).toMatchObject({ level: "warn", msg: "internal_api_refused", reason: "no bearer token" });
    });

    it("refuses a subject of another length without comparing it", async () => {
        verify.mockResolvedValue({ subject: "short" });
        await start();
        expect((await call("/v1/secrets/x", { method: "DELETE" })).status).toBe(403);
        expect(logged()[0]).toMatchObject({ reason: "the token's subject is not the server's" });
    });

    it("refuses another API version", async () => {
        await start();
        const response = await call("/v2/secrets/x", { method: "DELETE" });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ reason: "unsupported_api_version", supported: ["dns.rapidmx.io/v1"] });
    });

    it("refuses a body of another version or kind, a body that is not JSON, and one too large", async () => {
        await start({ maxBodyBytes: 100 });
        const v2 = await put("/v1/secrets/x", JSON.stringify({ apiVersion: "dns.rapidmx.io/v2", kind: "SecretWrite" }));
        expect(v2.status).toBe(400);
        expect(await v2.json()).toEqual({ reason: "unsupported_api_version", supported: ["dns.rapidmx.io/v1"] });
        const kind = await put("/v1/secrets/x", JSON.stringify({ apiVersion: "dns.rapidmx.io/v1", kind: "Other" }));
        expect(await kind.json()).toEqual({ reason: "unsupported_api_version", supported: ["dns.rapidmx.io/v1"] });
        const notJson = await put("/v1/secrets/x", "{");
        expect(notJson.status).toBe(400);
        expect(await notJson.json()).toEqual({ reason: "invalid_payload", message: "the body is not JSON" });
        const large = await put("/v1/secrets/x", JSON.stringify({ apiVersion: "dns.rapidmx.io/v1", kind: "SecretWrite", pad: "x".repeat(200) }));
        expect(large.status).toBe(413);
        expect(await large.json()).toEqual({ reason: "too_large" });
        expect(handled).toEqual([]);
    });

    it("answers 404 for an unknown path and 405 for a known one with another method", async () => {
        await start();
        for (const path of ["/v1/unknown", "/", "/v1", "/healthz"]) {
            const response = await call(path);
            expect(response.status).toBe(404);
            expect(await response.json()).toEqual({ reason: "not_found" });
        }
        const response = await call("/v1/secrets/x?x=1", { method: "POST", body: "{}" });
        expect(response.status).toBe(405);
        expect(await response.json()).toEqual({ reason: "method_not_allowed" });
    });

    it("serves nothing while the controller may not write (incompatible, or not holding the Lease)", async () => {
        writable = false;
        await start();
        const response = await call("/v1/secrets/x", { method: "DELETE" });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ reason: "not_ready" });
        expect(handled).toEqual([]);
    });

    it("answers 500 when a route fails, logging the error", async () => {
        await start();
        const response = await call("/v1/secrets/boom", { method: "DELETE" });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ reason: "internal_error" });
        expect(logged().find((e) => e.msg === "internal_api_failed")).toMatchObject({ level: "error", method: "DELETE", error: { message: "kube down" } });
    });

    it("has no routes unless given some", async () => {
        await start({ routes: undefined });
        expect((await call("/v1/secrets/x", { method: "DELETE" })).status).toBe(404);
    });

    it("listens on all interfaces by default and closes", async () => {
        server = new InternalApiServer({ verifier: { verify }, subject: SUBJECT, gate: { mayWrite: () => true }, log: new Logger("error", () => undefined) });
        const port = await server.listen(0);
        expect((await fetch(`http://127.0.0.1:${port}/v1/x`)).status).toBe(403);
        await server.close();
        await expect(fetch(`http://127.0.0.1:${port}/v1/x`)).rejects.toThrow();
        server = undefined;
    });

    // On a single-stack IPv6 cluster the server reaches the controller's Service only over IPv6.
    it.skipIf(!ipv6)("takes IPv6 as well as IPv4 by default", async () => {
        server = new InternalApiServer({ verifier: { verify }, subject: SUBJECT, gate: { mayWrite: () => true }, log: new Logger("error", () => undefined) });
        const port = await server.listen(0);
        expect((await fetch(`http://[::1]:${port}/v1/x`)).status).toBe(403);
        expect((await fetch(`http://127.0.0.1:${port}/v1/x`)).status).toBe(403);
        await server.close();
        server = undefined;
    });

    it("rejects listening on a port in use", async () => {
        await start();
        const other = new InternalApiServer({ verifier: { verify }, subject: SUBJECT, gate: { mayWrite: () => true }, log: new Logger("error", () => undefined) });
        await expect(other.listen(Number(new URL(base).port), "127.0.0.1")).rejects.toThrow(/EADDRINUSE/);
    });
});
