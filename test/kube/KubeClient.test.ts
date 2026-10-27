import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    httpsTransport,
    isKubeStatus,
    KubeClient,
    KubeError,
    MAX_BODY_BYTES,
    type KubeRequest,
    type KubeResponse,
} from "../../src/kube/KubeClient.js";

const fixtures = new URL("../fixtures/tls/", import.meta.url);
const cert = readFileSync(new URL("server.crt", fixtures), "utf8");
const key = readFileSync(new URL("server.key", fixtures), "utf8");

function serviceAccountDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "dns-controller-sa-"));
    writeFileSync(join(dir, "token"), "token-1\n");
    writeFileSync(join(dir, "namespace"), "rapidmx\n");
    writeFileSync(join(dir, "ca.crt"), cert);
    return dir;
}

describe("KubeClient", () => {
    let dir: string;
    let requests: KubeRequest[];
    let answer: KubeResponse | Error;

    function client(host = "10.43.0.1"): KubeClient {
        return new KubeClient({
            host,
            port: "443",
            serviceAccountDir: dir,
            transport: async (request) => {
                requests.push(request);
                if (answer instanceof Error) {
                    throw answer;
                }
                return answer;
            },
        });
    }

    beforeEach(() => {
        dir = serviceAccountDir();
        requests = [];
        answer = { status: 200, body: '{"ok":true}' };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("reads the namespace and the token from the ServiceAccount mount", async () => {
        expect(await client().namespace()).toBe("rapidmx");
        expect(await client().token()).toBe("token-1");
    });

    it("GETs JSON with the token, the cluster CA and a timeout", async () => {
        expect(await client().get("/api/v1/namespaces/rapidmx/pods")).toEqual({ ok: true });
        const [request] = requests;
        expect(request.method).toBe("GET");
        expect(request.url.href).toBe("https://10.43.0.1/api/v1/namespaces/rapidmx/pods");
        expect(request.headers).toEqual({ Accept: "application/json", Authorization: "Bearer token-1" });
        expect(request.body).toBeUndefined();
        expect(request.ca).toBe(cert);
        expect(request.timeoutMs).toBe(10000);
    });

    it("re-reads the token on every request but reads the CA once", async () => {
        const c = client();
        await c.get("/a");
        writeFileSync(join(dir, "token"), "token-2");
        writeFileSync(join(dir, "ca.crt"), "changed");
        await c.get("/b");
        expect(requests[1].headers.Authorization).toBe("Bearer token-2");
        expect(requests[1].ca).toBe(cert);
    });

    it("brackets an IPv6 API server address", async () => {
        await client("fd00::1").get("/version");
        expect(requests[0].url.host).toBe("[fd00::1]");
    });

    it("POSTs, PUTs and DELETEs with JSON bodies", async () => {
        const c = client();
        await c.create("/apis/x", { a: 1 });
        await c.replace("/apis/x/y", { b: 2 });
        await c.delete("/apis/x/y");
        expect(requests.map((r) => [r.method, r.body, r.headers["Content-Type"]])).toEqual([
            ["POST", '{"a":1}', "application/json"],
            ["PUT", '{"b":2}', "application/json"],
            ["DELETE", undefined, undefined],
        ]);
    });

    it("applies with the field manager, and force only when asked", async () => {
        const c = client();
        await c.apply("/apis/x/y", { c: 3 }, { fieldManager: "rapidmx-dns-controller" });
        await c.apply("/apis/x/y", { c: 3 }, { fieldManager: "rapidmx-dns-controller", force: true });
        expect(requests[0].method).toBe("PATCH");
        expect(requests[0].headers["Content-Type"]).toBe("application/apply-patch+yaml");
        expect(requests[0].url.search).toBe("?fieldManager=rapidmx-dns-controller");
        expect(requests[1].url.search).toBe("?fieldManager=rapidmx-dns-controller&force=true");
    });

    it("reads an object's metadata alone, so a Secret's values never reach the controller", async () => {
        answer = { status: 200, body: '{"kind":"PartialObjectMetadata","metadata":{"name":"s"}}' };
        expect(await client().getMetadata("/api/v1/namespaces/rapidmx/secrets/s")).toEqual({ kind: "PartialObjectMetadata", metadata: { name: "s" } });
        expect(requests[0].method).toBe("GET");
        expect(requests[0].headers.Accept).toBe("application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1");
    });

    it("returns undefined for an empty success body", async () => {
        answer = { status: 200, body: "" };
        expect(await client().delete("/apis/x/y")).toBeUndefined();
    });

    it("turns a Kubernetes Status answer into a KubeError with status and reason", async () => {
        answer = { status: 409, body: JSON.stringify({ kind: "Status", reason: "Conflict", message: "the object has been modified" }) };
        const err = await client().replace("/apis/x/y", {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(KubeError);
        expect(err).toMatchObject({ status: 409, reason: "Conflict", message: "PUT /apis/x/y: HTTP 409: the object has been modified" });
        expect(isKubeStatus(err, 409)).toBe(true);
        expect(isKubeStatus(err, 404)).toBe(false);
        expect(isKubeStatus(new Error("x"), 409)).toBe(false);
    });

    it("reports an error answer without a Status body", async () => {
        answer = { status: 503, body: "" };
        await expect(client().get("/x")).rejects.toMatchObject({ status: 503, reason: undefined, message: "GET /x: HTTP 503" });
        answer = { status: 500, body: '{"reason":5,"message":7}' };
        await expect(client().get("/x")).rejects.toMatchObject({ status: 500, reason: undefined, message: "GET /x: HTTP 500" });
    });

    it("reports an answer that is not JSON", async () => {
        answer = { status: 502, body: "<html>" };
        await expect(client().get("/x")).rejects.toMatchObject({ status: 502, message: "GET /x: HTTP 502, the answer was not JSON" });
    });

    it("reports no answer by its error code, else its message", async () => {
        answer = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        await expect(client().get("/x")).rejects.toMatchObject({ status: undefined, message: "GET /x: ECONNREFUSED" });
        answer = new Error("socket hang up");
        await expect(client().get("/x")).rejects.toMatchObject({ message: "GET /x: socket hang up" });
    });

    it("reports a thrown non-Error", async () => {
        const c = new KubeClient({
            host: "h",
            port: "1",
            serviceAccountDir: dir,
            transport: () => Promise.reject(undefined),
        });
        await expect(c.get("/x")).rejects.toMatchObject({ message: "GET /x: undefined" });
    });

    it("fails without a cluster CA instead of talking to an unverified server", async () => {
        rmSync(join(dir, "ca.crt"));
        await expect(client().get("/x")).rejects.toThrow(/ca\.crt/);
        expect(requests).toHaveLength(0);
    });
});

describe("httpsTransport", () => {
    let server: https.Server;
    let port: number;
    let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;

    beforeAll(async () => {
        server = https.createServer({ cert, key }, (req, res) => handler(req, res));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    function request(overrides: Partial<KubeRequest> = {}): KubeRequest {
        return {
            method: "POST",
            url: new URL(`https://127.0.0.1:${port}/apis/x?y=1`),
            headers: { "Content-Type": "application/json" },
            body: '{"a":1}',
            ca: cert,
            timeoutMs: 2000,
            ...overrides,
        };
    }

    it("sends the method, path and body to a server the CA verifies, and returns status and body", async () => {
        let seen: { method?: string; url?: string; body: string } = { body: "" };
        handler = (req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                seen = { method: req.method, url: req.url, body };
                res.writeHead(201, { "Content-Type": "application/json" });
                res.end('{"created":true}');
            });
        };
        expect(await httpsTransport(request())).toEqual({ status: 201, body: '{"created":true}' });
        expect(seen).toEqual({ method: "POST", url: "/apis/x?y=1", body: '{"a":1}' });
    });

    it("is the KubeClient's default transport, with its timeout", async () => {
        handler = (req, res) => res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization }));
        const dir = serviceAccountDir();
        try {
            const c = new KubeClient({ host: "127.0.0.1", port: String(port), serviceAccountDir: dir, timeoutMs: 2000 });
            expect(await c.get("/version")).toEqual({ path: "/version", auth: "Bearer token-1" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("refuses a server the CA does not verify", async () => {
        handler = (_req, res) => res.end("{}");
        await expect(httpsTransport(request({ ca: undefined }))).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    });

    it("gives up after the timeout", async () => {
        handler = () => undefined;
        await expect(httpsTransport(request({ method: "GET", body: undefined, timeoutMs: 100 }))).rejects.toThrow(
            "no answer within 100 ms"
        );
    });

    it("refuses an answer larger than the limit", async () => {
        handler = (_req, res) => {
            res.writeHead(200);
            const chunk = Buffer.alloc(1024 * 1024, 0x20);
            for (let i = 0; i <= MAX_BODY_BYTES / chunk.length; i++) {
                res.write(chunk);
            }
            res.end();
        };
        await expect(httpsTransport(request({ method: "GET", body: undefined, timeoutMs: 10000 }))).rejects.toThrow(
            "the response was too large"
        );
    });
});
