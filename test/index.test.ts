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
    /** The items a list of the namespace's objects answers with, by path; every other read is a 404. */
    let listed: Record<string, unknown[]>;
    /** The objects a read of one path answers with; every other read is a 404. */
    let found: Record<string, unknown>;
    /** The applied DNSEndpoint and the status reports, in the order they happened. */
    let order: string[];

    const kubeTransport = async (request: KubeRequest): Promise<KubeResponse> => {
        kubeRequests.push(request);
        if (request.method === "PATCH" && request.url.pathname.includes("/dnsendpoints/")) {
            order.push("endpoint");
        }
        if (request.method === "GET" && listed[request.url.pathname]) {
            return { status: 200, body: JSON.stringify({ items: listed[request.url.pathname] }) };
        }
        if (request.method === "GET" && found[request.url.pathname]) {
            return { status: 200, body: JSON.stringify(found[request.url.pathname]) };
        }
        if (request.method === "GET") {
            return { status: 404, body: JSON.stringify({ kind: "Status", reason: "NotFound" }) };
        }
        // An apply answers with the object, to which the API server has given a uid.
        const applied = request.method === "PATCH" && request.body ? JSON.parse(request.body) : undefined;
        if (applied) {
            applied.metadata.uid = `uid-of-${applied.metadata.name}`;
        }
        return { status: 201, body: applied ? JSON.stringify(applied) : (request.body ?? "") };
    };
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const desiredState = JSON.parse(readFileSync(new URL("./fixtures/api/v1/desired-state.json", import.meta.url), "utf8"));
    const credentials = JSON.parse(readFileSync(new URL("./fixtures/api/v1/provider-credentials.json", import.meta.url), "utf8"));
    /** The server: the handshake, the desired state (a long poll that is never answered), a provider's credentials, and the status report. */
    const fakeFetch = (async (url: string, init: RequestInit) => {
        fetchCalls.push([url, init]);
        if (url.endsWith("/v1/status")) {
            order.push("report");
        }
        if (url.endsWith("/handshake")) {
            return json(handshakeAnswer);
        }
        if (url.includes("/v1/desired-state?since=")) {
            return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
        }
        if (url.endsWith("/v1/desired-state")) {
            return json(desiredState);
        }
        if (url.endsWith("/v1/providers/cloudflare-main/credentials")) {
            return json(credentials);
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
        };
        fetchCalls = [];
        listed = {};
        found = {};
        order = [];
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
            // The desired state is reconciled into the namespace: the provider's instance, its Secret from the credentials the server
            // sends, and the domain's DNSEndpoint.
            await waitFor(() => kubeRequests.some((r) => r.method === "PATCH" && r.url.pathname.endsWith("/dnsendpoints/mail-domain-example-com")));
            const applied = kubeRequests.filter((r) => r.method === "PATCH").map((r) => r.url.pathname);
            expect(applied).toEqual([
                "/apis/apps/v1/namespaces/rapidmx/deployments/mail-external-dns-cloudflare-main",
                "/api/v1/namespaces/rapidmx/secrets/mail-dns-cloudflare-main",
                "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints/mail-domain-example-com",
            ]);
            // The Secret holds what the server sent, owned by the Deployment, and the controller asked with its projected token.
            const secret = JSON.parse(String(kubeRequests.find((r) => r.method === "PATCH" && r.url.pathname.endsWith("/secrets/mail-dns-cloudflare-main")).body));
            expect(secret).toMatchObject({
                kind: "Secret",
                data: { apiToken: Buffer.from("cf-example-token-not-a-real-secret").toString("base64") },
                metadata: { ownerReferences: [{ kind: "Deployment", name: "mail-external-dns-cloudflare-main", uid: "uid-of-mail-external-dns-cloudflare-main" }] },
            });
            const fetchedCredentials = fetchCalls.find(([url]) => url.endsWith("/v1/providers/cloudflare-main/credentials"));
            expect(fetchedCredentials[1].headers).toMatchObject({ Authorization: "Bearer projected" });
            expect(lines.join("\n")).not.toContain("cf-example-token-not-a-real-secret");
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

    it("reports what it finds of the instances and endpoints in the namespace, once it holds the Lease", async () => {
        listed["/apis/apps/v1/namespaces/rapidmx/deployments"] = [
            {
                metadata: { name: "mail-external-dns-cloudflare-main", generation: 2, labels: { "rapidmx.io/dns-provider": "cloudflare-main" } },
                spec: { template: { spec: { containers: [{ name: "external-dns", image: "registry.k8s.io/external-dns/external-dns:v0.23.0" }] } } },
                status: { observedGeneration: 2, readyReplicas: 1, conditions: [{ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable", lastUpdateTime: "2026-10-28T08:00:00Z" }] },
            },
        ];
        listed["/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints"] = [
            { metadata: { name: "mail-domain-example-com", generation: 4, labels: { "rapidmx.io/dns-provider": "cloudflare-main" } }, status: { observedGeneration: 3 } },
        ];
        const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        try {
            await waitFor(() => running.elector.holds() && running.sync.desiredState !== undefined);
            await running.sync.report();
            const reports = fetchCalls.filter(([url]) => url.endsWith("/v1/status")).map(([, init]) => JSON.parse(String(init.body)));
            expect(reports[reports.length - 1]).toMatchObject({
                lease: { holder: true },
                providers: [
                    { providerUid: "cloudflare-main", readyReplicas: 1, image: "registry.k8s.io/external-dns/external-dns:v0.23.0", lastRolloutAt: "2026-10-28T08:00:00.000Z" },
                ],
                endpoints: [{ endpointSetId: "domain-example-com", generation: 4, observedGeneration: 3 }],
                operations: [],
            });
        } finally {
            await running.stop();
        }
    });

    it("reports again when the pass that applied the desired state ends, not only at the next interval", async () => {
        const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
        try {
            // The first report goes out as the state arrives, before anything is applied; the status interval is a minute.
            await waitFor(() => order.includes("endpoint") && order.lastIndexOf("report") > order.indexOf("endpoint"));
        } finally {
            await running.stop();
        }
    });

    it("keeps the results of the operations the desired state lists and forgets the others as it arrives, and all of them when the Lease is lost", async () => {
        const served = desiredState.operations;
        desiredState.operations = [{ id: "op-1", type: "test", providerUid: "cloudflare-main" }];
        try {
            const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
            try {
                // Recorded before the state arrives (the handshake is still on its way).
                running.ledger.record("op-1", "running");
                running.ledger.record("op-old", "succeeded");
                await waitFor(() => running.sync.desiredState !== undefined);
                expect(running.ledger.get("op-1")).toMatchObject({ state: "running" });
                expect(running.ledger.get("op-old")).toBeUndefined();
                await waitFor(() => running.elector.holds());
            } finally {
                await running.stop();
            }
            // Stopping released the Lease.
            expect(running.ledger.get("op-1")).toBeUndefined();
        } finally {
            desiredState.operations = served;
        }
    });

    it("runs a queued operation as a one-shot Job once the instance and the Secret are there, and reports it running", async () => {
        const served = desiredState.operations;
        desiredState.operations = [{ id: "op-1", type: "test", providerUid: "cloudflare-main" }];
        listed["/apis/batch/v1/namespaces/rapidmx/jobs"] = [];
        listed["/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints"] = [];
        found["/api/v1/namespaces/rapidmx/secrets/mail-dns-cloudflare-main"] = {
            metadata: {
                labels: { "app.kubernetes.io/managed-by": "rapidmx-dns-controller", "rapidmx.io/secret-kind": "dns", "rapidmx.io/dns-provider": "cloudflare-main" },
                annotations: { "rapidmx.io/credentials-generation": "1" },
                ownerReferences: [{ kind: "Deployment", name: "mail-external-dns-cloudflare-main", uid: "uid-of-mail-external-dns-cloudflare-main" }],
            },
        };
        try {
            const running = await startController(env, { kubeTransport, fetch: fakeFetch, sink: (l) => lines.push(l), healthPort: 0 });
            try {
                await waitFor(() => kubeRequests.some((r) => r.method === "POST" && r.url.pathname === "/apis/batch/v1/namespaces/rapidmx/jobs"));
                const job = JSON.parse(String(kubeRequests.find((r) => r.method === "POST" && r.url.pathname.endsWith("/jobs")).body));
                expect(job).toMatchObject({ kind: "Job", metadata: { name: "mail-op-71a0ef7195df4865" } });
                expect(job.spec.template.spec.containers[0].args).toEqual(expect.arrayContaining(["--registry=noop", "--policy=upsert-only", "--once", "--dry-run"]));
                // The result reaches the server with the report that follows the pass.
                await waitFor(() =>
                    fetchCalls.some(([url, init]) => url.endsWith("/v1/status") && JSON.parse(String(init.body)).operations.some((o: { id: string }) => o.id === "op-1"))
                );
                const reports = fetchCalls.filter(([url]) => url.endsWith("/v1/status")).map(([, init]) => JSON.parse(String(init.body)));
                expect(reports.at(-1).operations).toEqual([{ id: "op-1", state: "running", message: expect.stringContaining("dry run") }]);
            } finally {
                await running.stop();
            }
        } finally {
            desiredState.operations = served;
        }
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
