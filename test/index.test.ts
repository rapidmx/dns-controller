import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMain, startController } from "../src/index.js";
import type { KubeRequest, KubeResponse } from "../src/kube/KubeClient.js";

describe("startController / runMain", () => {
    let dir: string;
    let env: NodeJS.ProcessEnv;
    let kubeRequests: KubeRequest[];
    let lines: string[];
    let handshakeAnswer: unknown;
    let fetchCalls: [string, RequestInit][];

    const kubeTransport = async (request: KubeRequest): Promise<KubeResponse> => {
        kubeRequests.push(request);
        if (request.method === "GET") {
            return { status: 404, body: JSON.stringify({ kind: "Status", reason: "NotFound" }) };
        }
        return { status: 201, body: request.body ?? "" };
    };
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const desiredState = JSON.parse(readFileSync(new URL("./fixtures/api/v1/desired-state.json", import.meta.url), "utf8"));
    /** The server: the handshake, the desired state (a long poll that is never answered), and the status report. */
    const fakeFetch = (async (url: string, init: RequestInit) => {
        fetchCalls.push([url, init]);
        if (url.endsWith("/handshake")) {
            return json(handshakeAnswer);
        }
        if (url.includes("/v1/desired-state?since=")) {
            return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        }
        if (url.endsWith("/v1/desired-state")) {
            return json(desiredState);
        }
        return json({ apiVersion: "dns.rapidmx.io/v1", kind: "StatusReportResult" });
    }) as unknown as typeof fetch;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "dns-controller-index-"));
        writeFileSync(join(dir, "token"), "sa-token");
        writeFileSync(join(dir, "namespace"), "rapidmx");
        writeFileSync(join(dir, "ca.crt"), "ca");
        writeFileSync(join(dir, "server-token"), "projected");
        env = {
            DNS_CONTROLLER_SERVER_URL: "http://mail:3000/internal/dns",
            DNS_CONTROLLER_SERVER_TOKEN_FILE: join(dir, "server-token"),
            DNS_CONTROLLER_LEASE_NAME: "mail-dns-controller",
            DNS_CONTROLLER_SERVICE_ACCOUNT_DIR: dir,
            DNS_CONTROLLER_HEALTH_PORT: "1",
            KUBERNETES_SERVICE_HOST: "10.43.0.1",
            POD_NAME: "mail-dns-controller-abc",
            DNS_CONTROLLER_FULLNAME: "mail",
            DNS_CONTROLLER_RELEASE: "mail",
            DNS_CONTROLLER_OPENBAO_SECRET_STORE: "mail-openbao",
            DNS_CONTROLLER_OPENBAO_PATH_PREFIX: "mail/integrations",
        };
        fetchCalls = [];
        kubeRequests = [];
        lines = [];
        handshakeAnswer = {
            kind: "HandshakeResult",
            serverVersion: "1.0.0-beta.47",
            apiVersions: ["dns.rapidmx.io/v1"],
            compatible: true,
            selected: "dns.rapidmx.io/v1",
        };
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        vi.restoreAllMocks();
    });

    async function waitFor(check: () => boolean): Promise<void> {
        for (let i = 0; i < 200 && !check(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(check()).toBe(true);
    }

    /** A port nothing listens on: bound and released again. */
    async function listenFreePort(): Promise<number> {
        const probe = await import("node:net").then((net) => net.createServer());
        await new Promise<void>((resolve) => probe.listen(0, "0.0.0.0", resolve));
        const free = (probe.address() as import("node:net").AddressInfo).port;
        await new Promise((resolve) => probe.close(resolve));
        return free;
    }

    it("handshakes, takes the Lease in its namespace, reads the desired state, reports, serves health, and stops cleanly", async () => {
        const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        try {
            expect(running.healthPort).toBeGreaterThan(0);
            await waitFor(() => running.elector.holds());
            expect(running.controller.mayWrite()).toBe(true);
            expect(kubeRequests.slice(0, 2).map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                "GET /apis/coordination.k8s.io/v1/namespaces/rapidmx/leases/mail-dns-controller",
                "POST /apis/coordination.k8s.io/v1/namespaces/rapidmx/leases",
            ]);
            await waitFor(() => fetchCalls.some(([url]) => url.endsWith("/v1/desired-state?since=42")));
            // The desired state is reconciled into the namespace: the provider's instance and the domain's DNSEndpoint.
            await waitFor(() => kubeRequests.some((r) => r.method === "PATCH" && r.url.pathname.endsWith("/dnsendpoints/mail-domain-example-com")));
            const applied = kubeRequests.filter((r) => r.method === "PATCH").map((r) => r.url.pathname);
            expect(applied).toEqual([
                "/apis/external-secrets.io/v1/namespaces/rapidmx/externalsecrets/mail-dns-cloudflare-main",
                "/apis/apps/v1/namespaces/rapidmx/deployments/mail-external-dns-cloudflare-main",
                "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints/mail-domain-example-com",
            ]);
            const urls = fetchCalls.map(([url]) => url);
            expect(urls.slice(0, 2)).toEqual(["http://mail:3000/internal/dns/handshake", "http://mail:3000/internal/dns/v1/desired-state"]);
            expect(urls).toContain("http://mail:3000/internal/dns/v1/status");
            const report = JSON.parse(String(fetchCalls.find(([url]) => url.endsWith("/v1/status"))[1].body));
            expect(report).toMatchObject({ kind: "StatusReport", desiredStateVersion: 42, lease: { identity: "mail-dns-controller-abc" } });
            const ready = await fetch(`http://127.0.0.1:${running.healthPort}/readyz`);
            expect(ready.status).toBe(200);
            expect(await ready.json()).toMatchObject({ state: "compatible", leaseHolder: true, apiVersion: "dns.rapidmx.io/v1", desiredStateVersion: 42 });
            const started = JSON.parse(lines[0]);
            expect(started).toMatchObject({
                msg: "started",
                component: "dns-controller",
                namespace: "rapidmx",
                identity: "mail-dns-controller-abc",
            });
        } finally {
            await running.stop();
        }
        expect(JSON.parse(lines[lines.length - 1]).msg).toBe("stopped");
        // Stopping ended the long poll.
        const poll = fetchCalls.find(([url]) => url.endsWith("?since=42"));
        expect(poll[1].signal.aborted).toBe(true);
    });

    it("listens only on the health port: the controller serves no API of its own", async () => {
        const freePort = await listenFreePort();
        const running = await startController({ ...env, DNS_CONTROLLER_API_PORT: String(freePort) }, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        try {
            expect(running).not.toHaveProperty("apiPort");
            expect(JSON.parse(lines[0])).not.toHaveProperty("apiPort");
            // Nothing took the old internal API's port.
            await expect(fetch(`http://127.0.0.1:${freePort}/v1/secrets/x`, { method: "DELETE" })).rejects.toThrow();
        } finally {
            await running.stop();
        }
    });

    it("logs to stdout and listens on the configured port by default", async () => {
        const port = await listenFreePort();
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const running = await startController(
            { ...env, DNS_CONTROLLER_HEALTH_PORT: String(port) },
            { kubeTransport, fetch: fakeFetch }
        );
        try {
            expect(running.healthPort).toBe(port);
            expect(String(write.mock.calls[0][0])).toContain('"msg":"started"');
        } finally {
            await running.stop();
        }
    });

    it("throws on an invalid configuration", async () => {
        await expect(startController({ ...env, DNS_CONTROLLER_SERVER_URL: "" })).rejects.toThrow("DNS_CONTROLLER_SERVER_URL must be set");
    });

    it("exits 1 with the reason logged when it cannot start", async () => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        await runMain({ ...env, KUBERNETES_SERVICE_HOST: "" }, { sink: (l) => lines.push(l) });
        expect(exit).toHaveBeenCalledWith(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            level: "error",
            msg: "start_failed",
            component: "dns-controller",
            error: { name: "ConfigError", message: "KUBERNETES_SERVICE_HOST must be set." },
        });
    });

    it("logs to stdout when no sink is given", async () => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        await runMain({ ...env, KUBERNETES_SERVICE_HOST: "" });
        expect(String(write.mock.calls[0][0])).toContain("start_failed");
        expect(exit).toHaveBeenCalledWith(1);
    });

    it.each(["SIGTERM", "SIGINT"])("stops and exits 0 on %s", async (signal) => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        await runMain(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        process.emit(signal as NodeJS.Signals, signal as NodeJS.Signals);
        await waitFor(() => exit.mock.calls.length > 0);
        expect(exit).toHaveBeenCalledWith(0);
        expect(lines.map((l) => JSON.parse(l).msg)).toContain("shutting_down");
    });

    it("uses the process environment by default", async () => {
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const saved = process.env.DNS_CONTROLLER_SERVER_URL;
        delete process.env.DNS_CONTROLLER_SERVER_URL;
        try {
            await runMain();
            await expect(startController()).rejects.toThrow("DNS_CONTROLLER_SERVER_URL must be set");
        } finally {
            if (saved !== undefined) {
                process.env.DNS_CONTROLLER_SERVER_URL = saved;
            }
        }
        expect(exit).toHaveBeenCalledWith(1);
    });
});
