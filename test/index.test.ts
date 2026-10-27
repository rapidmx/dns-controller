import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    const kubeTransport = async (request: KubeRequest): Promise<KubeResponse> => {
        kubeRequests.push(request);
        if (request.method === "GET") {
            return { status: 404, body: JSON.stringify({ kind: "Status", reason: "NotFound" }) };
        }
        return { status: 201, body: request.body ?? "" };
    };
    const fakeFetch = (async () =>
        new Response(JSON.stringify(handshakeAnswer), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

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
        };
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

    it("handshakes, takes the Lease in its namespace, serves health, and stops cleanly", async () => {
        const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        try {
            expect(running.healthPort).toBeGreaterThan(0);
            await waitFor(() => running.elector.holds());
            expect(running.controller.mayWrite()).toBe(true);
            expect(kubeRequests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
                "GET /apis/coordination.k8s.io/v1/namespaces/rapidmx/leases/mail-dns-controller",
                "POST /apis/coordination.k8s.io/v1/namespaces/rapidmx/leases",
            ]);
            const ready = await fetch(`http://127.0.0.1:${running.healthPort}/readyz`);
            expect(ready.status).toBe(200);
            expect(await ready.json()).toMatchObject({ state: "compatible", leaseHolder: true, apiVersion: "dns.rapidmx.io/v1" });
            const started = JSON.parse(lines[0]);
            expect(started).toMatchObject({ msg: "started", component: "dns-controller", namespace: "rapidmx", identity: "mail-dns-controller-abc" });
        } finally {
            await running.stop();
        }
        expect(JSON.parse(lines[lines.length - 1]).msg).toBe("stopped");
    });

    it("logs to stdout and listens on the configured port by default", async () => {
        const probe = await import("node:net").then((net) => net.createServer());
        await new Promise<void>((resolve) => probe.listen(0, "0.0.0.0", resolve));
        const port = (probe.address() as import("node:net").AddressInfo).port;
        await new Promise((resolve) => probe.close(resolve));
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const running = await startController({ ...env, DNS_CONTROLLER_HEALTH_PORT: String(port) }, { kubeTransport, fetch: fakeFetch });
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
