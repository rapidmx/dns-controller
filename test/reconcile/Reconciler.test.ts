import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1 } from "../../src/api/v1.js";
import { KubeError, type ApplyOptions } from "../../src/kube/KubeClient.js";
import { Logger } from "../../src/log.js";
import { dnsEndpoint, externalDnsDeployment, externalSecret, type ManifestSettings } from "../../src/reconcile/manifests.js";
import { Reconciler } from "../../src/reconcile/Reconciler.js";

const DEPLOYMENTS = "/apis/apps/v1/namespaces/rapidmx/deployments";
const ENDPOINTS = "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints";
const EXTERNAL_SECRETS = "/apis/external-secrets.io/v1/namespaces/rapidmx/externalsecrets";
const SECRETS = "/api/v1/namespaces/rapidmx/secrets";
const SELECTOR = "labelSelector=app.kubernetes.io%2Fmanaged-by%3Drapidmx-dns-controller%2Capp.kubernetes.io%2Finstance%3Dmail";

const settings: ManifestSettings = {
    namespace: "rapidmx",
    fullname: "mail",
    release: "mail",
    externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
    externalDnsServiceAccount: "mail-external-dns",
    openbao: { secretStore: "mail-openbao", pathPrefix: "mail/integrations", externalSecretsApiVersion: "external-secrets.io/v1" },
};

type KubeObject = { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string>; generation?: number }; [key: string]: unknown };

/** An in-memory namespace: server-side apply, label-selected lists, metadata-only reads and deletes, with failures on demand. */
class FakeKube {
    objects = new Map<string, KubeObject>();
    calls: string[] = [];
    applyOptions: ApplyOptions[] = [];
    failures = new Map<string, Error>();

    private fail(call: string): void {
        this.calls.push(call);
        for (const [prefix, error] of this.failures) {
            if (call.startsWith(prefix)) {
                throw error;
            }
        }
    }

    put(path: string, labels: Record<string, string>, annotations?: Record<string, string>): void {
        const name = path.slice(path.lastIndexOf("/") + 1);
        this.objects.set(path, { metadata: { name, labels, ...(annotations ? { annotations } : {}) } });
    }

    readonly client = {
        apply: async <T>(path: string, body: KubeObject, options: ApplyOptions): Promise<T> => {
            this.fail(`APPLY ${path}`);
            this.applyOptions.push(options);
            const before = this.objects.get(path);
            const changed = JSON.stringify(before?.spec) !== JSON.stringify(body.spec);
            const generation = (before?.metadata.generation ?? 0) + (changed ? 1 : 0);
            const stored = { ...structuredClone(body), metadata: { ...structuredClone(body.metadata), generation } };
            this.objects.set(path, stored);
            return structuredClone(stored) as T;
        },
        get: async <T>(path: string): Promise<T> => {
            this.fail(`GET ${path}`);
            const [collection, query] = path.split("?");
            const wanted = Object.fromEntries(
                decodeURIComponent(new URLSearchParams(query).get("labelSelector") ?? "")
                    .split(",")
                    .map((pair) => pair.split("="))
            );
            const items = [...this.objects.entries()]
                .filter(([key, obj]) => key.startsWith(`${collection}/`) && Object.entries(wanted).every(([k, v]) => obj.metadata.labels?.[k] === v))
                .map(([, obj]) => structuredClone(obj));
            // The API server may leave `items` out of an empty list.
            return (items.length > 0 ? { items } : {}) as T;
        },
        getMetadata: async <T>(path: string): Promise<T> => {
            this.fail(`META ${path}`);
            const obj = this.objects.get(path);
            if (!obj) {
                throw new KubeError("not found", 404, "NotFound");
            }
            return { metadata: structuredClone(obj.metadata) } as T;
        },
        delete: async <T>(path: string): Promise<T> => {
            this.fail(`DELETE ${path}`);
            if (!this.objects.delete(path)) {
                throw new KubeError("not found", 404, "NotFound");
            }
            return {} as T;
        },
    };

    writes(): string[] {
        return this.calls.filter((c) => c.startsWith("APPLY") || c.startsWith("DELETE"));
    }
}

const fixtureText = readFileSync(new URL("../fixtures/api/v1/desired-state.json", import.meta.url), "utf8");
const fixture = (): DesiredStateV1 => parseDesiredState(JSON.parse(fixtureText));

const ours = (provider: string): Record<string, string> => ({
    "app.kubernetes.io/name": "external-dns",
    "app.kubernetes.io/instance": "mail",
    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
    "rapidmx.io/dns-provider": provider,
});

describe("Reconciler", () => {
    let kube: FakeKube;
    let lines: string[];
    let writable: boolean;
    let clock: number;

    function reconciler(extra: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}): Reconciler {
        return new Reconciler({
            kube: kube.client,
            settings,
            gate: { mayWrite: () => writable },
            log: new Logger("debug", (l) => lines.push(l)),
            now: () => clock,
            ...extra,
        });
    }

    const logged = (msg: string): Record<string, unknown>[] => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

    beforeEach(() => {
        kube = new FakeKube();
        lines = [];
        writable = true;
        clock = Date.parse("2026-10-28T10:00:00Z");
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("applies each provider's ExternalSecret and Deployment, then each endpoint set, with server-side apply as its own field manager", async () => {
        const state = fixture();
        expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
        expect(kube.writes()).toEqual([
            `APPLY ${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`,
            `APPLY ${DEPLOYMENTS}/mail-external-dns-cloudflare-main`,
            `APPLY ${ENDPOINTS}/mail-domain-example-com`,
        ]);
        expect(kube.applyOptions).toEqual(Array(3).fill({ fieldManager: "rapidmx-dns-controller", force: true }));
        const stored = (path: string): unknown => {
            const { metadata, ...rest } = kube.objects.get(path);
            const { generation: _generation, ...meta } = metadata;
            return { ...rest, metadata: meta };
        };
        expect(stored(`${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`)).toEqual(externalSecret(state.providers[0], settings));
        expect(stored(`${DEPLOYMENTS}/mail-external-dns-cloudflare-main`)).toEqual(externalDnsDeployment(state.providers[0], state.ownerId, settings, 1));
        expect(stored(`${ENDPOINTS}/mail-domain-example-com`)).toEqual(dnsEndpoint(state.endpointSets[0], "cloudflare", settings));
        // Lists select only what this release's controller manages.
        expect(kube.calls).toContain(`GET ${ENDPOINTS}?${SELECTOR}`);
        expect(kube.calls).toContain(`GET ${DEPLOYMENTS}?${SELECTOR}`);
        expect(kube.calls).toContain(`GET ${EXTERNAL_SECRETS}?${SELECTOR}`);
    });

    it("is idempotent: a second pass applies the same objects and deletes nothing", async () => {
        const r = reconciler();
        await r.reconcile(fixture());
        const before = structuredClone([...kube.objects.entries()]);
        kube.calls = [];
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.writes().filter((w) => w.startsWith("DELETE"))).toEqual([]);
        expect([...kube.objects.entries()]).toEqual(before);
    });

    it("writes nothing while it may not write", async () => {
        writable = false;
        expect(await reconciler().reconcile(fixture())).toEqual({ result: "not_writer" });
        expect(kube.calls).toEqual([]);
    });

    it("checks that it may write immediately before every write, stopping the pass the moment it may not", async () => {
        let allowed = 2;
        const r = new Reconciler({
            kube: kube.client,
            settings,
            gate: { mayWrite: () => allowed-- > 0 },
            log: new Logger("debug", (l) => lines.push(l)),
        });
        expect(await r.reconcile(fixture())).toEqual({ result: "not_writer" });
        expect(kube.writes()).toEqual([`APPLY ${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`]);
    });

    it("refuses a whole state it can't publish safely, before any call", async () => {
        const bad = (patch: (s: DesiredStateV1) => void): DesiredStateV1 => {
            const s = fixture();
            patch(s);
            return s;
        };
        const r = reconciler();
        for (const state of [
            bad((s) => (s.providers[0].uid = "Bad_Uid")),
            bad((s) => (s.providers[0].uid = "a".repeat(41))),
            bad((s) => (s.endpointSets[0].id = "domain.example.com")),
            bad((s) => (s.endpointSets[0].id = "a".repeat(181))),
            bad((s) => (s.endpointSets[0].providerUid = "unknown")),
            bad((s) => s.endpointSets.push({ ...s.endpointSets[0] })),
            bad((s) => s.providers.push({ ...s.providers[0] })),
            // No zone would mean no --domain-filter: every zone the credentials reach.
            bad((s) => (s.providers[0].zones = [])),
            bad((s) => (s.providers[0].zones = ["com"])),
            bad((s) => (s.providers[0].zones = ["example.com", "bad zone.com"])),
            bad((s) => (s.providers[0].zones = ["Example.com"])),
            // One zone, two instances sharing the owner id: each would delete the other's records.
            bad((s) => s.providers.push({ uid: "second", type: "route53", zones: ["example.org", "example.com"], options: {}, enabled: false })),
            // A credentials path outside dns/ would copy another secret into an external-dns pod.
            bad((s) => (s.providers[0].secretRef.path = "../../mail/secrets")),
            bad((s) => (s.providers[0].secretRef.path = "dns/../secrets")),
            bad((s) => (s.providers[0].secretRef.path = "/dns/x")),
            bad((s) => (s.providers[0].secretRef.path = "server/giphy")),
            bad((s) => (s.providers[0].secretRef.keys = ["apiToken", "a/b"])),
        ]) {
            expect(await r.reconcile(state)).toMatchObject({ result: "refused" });
        }
        expect(kube.calls).toEqual([]);
        expect(logged("desired_state_unpublishable")).toHaveLength(17);
        // The same zone listed twice by one config is not a conflict.
        expect(await r.reconcile(bad((s) => (s.providers[0].zones = ["example.com", "example.com"])))).toEqual({ result: "done" });
    });

    it("keeps a parent zone's instance out of a zone another config has nested under it", async () => {
        const state = fixture();
        state.providers.push({ uid: "sub", type: "route53", zones: ["sub.example.com"], options: {}, enabled: true });
        expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
        const args = (name: string): string[] =>
            (kube.objects.get(`${DEPLOYMENTS}/${name}`) as unknown as { spec: { template: { spec: { containers: { args: string[] }[] } } } }).spec.template.spec
                .containers[0].args;
        expect(args("mail-external-dns-cloudflare-main")).toContain("--exclude-domains=sub.example.com");
        expect(args("mail-external-dns-sub").some((a) => a.startsWith("--exclude-domains="))).toBe(false);
    });

    it("deletes the DNSEndpoints it manages that the desired state no longer has, and nothing it doesn't manage", async () => {
        kube.put(`${ENDPOINTS}/mail-domain-gone-com`, { ...ours("cloudflare-main"), "rapidmx.io/domain": "gone.com" });
        kube.put(`${ENDPOINTS}/someone-elses`, { "app.kubernetes.io/managed-by": "someone" });
        kube.put(`${ENDPOINTS}/other-release`, { ...ours("cloudflare-main"), "app.kubernetes.io/instance": "other" });
        expect(await reconciler().reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.writes()).toContain(`DELETE ${ENDPOINTS}/mail-domain-gone-com`);
        expect(kube.objects.has(`${ENDPOINTS}/someone-elses`)).toBe(true);
        expect(kube.objects.has(`${ENDPOINTS}/other-release`)).toBe(true);
    });

    it("removes a deleted provider's instance one interval after its endpoints, with its ExternalSecret and labelled Secret", async () => {
        kube.put(`${ENDPOINTS}/mail-hosts-old`, ours("old"));
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.put(`${EXTERNAL_SECRETS}/mail-dns-old`, { ...ours("old"), "rapidmx.io/secret-kind": "dns" });
        kube.put(`${SECRETS}/mail-dns-old`, { ...ours("old"), "rapidmx.io/secret-kind": "dns" });
        const r = reconciler({ providerRemovalDelayMs: 120000 });
        expect(await r.reconcile(fixture())).toEqual({ result: "done", nextAt: clock + 120000 });
        expect(kube.writes()).toContain(`DELETE ${ENDPOINTS}/mail-hosts-old`);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        clock += 60000;
        expect(await r.reconcile(fixture())).toEqual({ result: "done", nextAt: clock + 60000 });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        clock += 60000;
        kube.calls = [];
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        // The instance last: it is what marks the provider deleted until everything else is gone.
        expect(kube.writes().filter((w) => w.startsWith("DELETE"))).toEqual([
            `DELETE ${EXTERNAL_SECRETS}/mail-dns-old`,
            `DELETE ${SECRETS}/mail-dns-old`,
            `DELETE ${DEPLOYMENTS}/mail-external-dns-old`,
        ]);
        expect(logged("external_dns_removed")).toEqual([expect.objectContaining({ providerUid: "old" })]);
    });

    it("forgets a pending removal when the provider comes back, so a later deletion waits its interval again", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        const r = reconciler({ providerRemovalDelayMs: 120000 });
        expect(await r.reconcile(fixture())).toEqual({ result: "done", nextAt: clock + 120000 });
        const back = fixture();
        back.providers.push({ uid: "old", type: "route53", zones: ["example.org"], options: {}, enabled: true });
        clock += 60000;
        expect(await r.reconcile(back)).toEqual({ result: "done" });
        clock += 60000;
        expect(await r.reconcile(fixture())).toEqual({ result: "done", nextAt: clock + 120000 });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
    });

    it("never deletes a Secret by name alone: it must carry this controller's labels for that provider", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.put(`${SECRETS}/mail-dns-old`, { "app.kubernetes.io/managed-by": "Helm" });
        const r = reconciler({ providerRemovalDelayMs: 0 });
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(false);
        expect(kube.objects.has(`${SECRETS}/mail-dns-old`)).toBe(true);
    });

    it("keeps trying to remove a provider whose Secret it can't read or delete, keeping its instance as the mark until then", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.put(`${SECRETS}/mail-dns-old`, { ...ours("old"), "rapidmx.io/secret-kind": "dns" });
        kube.failures.set(`META ${SECRETS}/mail-dns-old`, new KubeError("forbidden", 403, "Forbidden"));
        const r = reconciler({ providerRemovalDelayMs: 0 });
        expect(await r.reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "delete", kind: "Secret", providerUid: "old" })]);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        kube.failures.clear();
        kube.failures.set(`DELETE ${SECRETS}/mail-dns-old`, new KubeError("boom", 500));
        expect(await r.reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        // With the Kubernetes backend nothing but the instance points at the Secret: the next pass finds it and finishes.
        kube.failures.clear();
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.objects.has(`${SECRETS}/mail-dns-old`)).toBe(false);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(false);
    });

    it("removes a deleted provider that never got an instance (its image refused) through its ExternalSecret", async () => {
        kube.put(`${EXTERNAL_SECRETS}/mail-dns-old`, { ...ours("old"), "rapidmx.io/secret-kind": "dns" });
        kube.put(`${SECRETS}/mail-dns-old`, { ...ours("old"), "rapidmx.io/secret-kind": "dns" });
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.writes().filter((w) => w.startsWith("DELETE"))).toEqual([`DELETE ${EXTERNAL_SECRETS}/mail-dns-old`, `DELETE ${SECRETS}/mail-dns-old`]);
    });

    it("tolerates a removed provider's objects being gone already", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`DELETE ${DEPLOYMENTS}/mail-external-dns-old`, new KubeError("not found", 404, "NotFound"));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.calls).toContain(`META ${SECRETS}/mail-dns-old`);
    });

    it("keeps a removed provider's instance while one of its endpoints couldn't be deleted, and starts over when it comes back", async () => {
        kube.put(`${ENDPOINTS}/mail-hosts-old`, ours("old"));
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`DELETE ${ENDPOINTS}/mail-hosts-old`, new KubeError("boom", 500));
        const r = reconciler({ providerRemovalDelayMs: 0 });
        expect(await r.reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        // The provider is back in the desired state: its removal clock is reset.
        kube.failures.clear();
        const back = fixture();
        back.providers.push({ ...back.providers[0], uid: "old", zones: ["example.org"], secretRef: undefined, type: "route53" });
        expect(await r.reconcile(back)).toEqual({ result: "done" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
    });

    it("removes nothing when it can't list what it manages", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`GET ${ENDPOINTS}?`, new KubeError("the server could not find the requested resource", 404, "NotFound"));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "list", kind: "DNSEndpoint" })]);
    });

    it("deletes the ExternalSecret of a provider whose credentials are no longer in OpenBao", async () => {
        kube.put(`${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`, { ...ours("cloudflare-main"), "rapidmx.io/secret-kind": "dns" });
        const state = fixture();
        state.providers[0].secretRef = { ...state.providers[0].secretRef, backend: "kubernetes" };
        expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
        expect(kube.writes()).toContain(`DELETE ${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`);
    });

    it("neither lists nor applies ExternalSecrets without OpenBao, and leaves a provider whose credentials are in OpenBao alone then", async () => {
        const { openbao: _openbao, ...plain } = settings;
        const state = fixture();
        state.providers.push({ uid: "r53", type: "route53", zones: ["example.org"], options: {}, enabled: true });
        expect(await reconciler({ settings: plain }).reconcile(state)).toMatchObject({ result: "incomplete" });
        expect(kube.calls.some((c) => c.includes("externalsecrets"))).toBe(false);
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENTS}/mail-external-dns-r53`, `APPLY ${ENDPOINTS}/mail-domain-example-com`]);
        expect(logged("reconcile_failed")).toEqual([
            expect.objectContaining({ providerUid: "cloudflare-main", error: expect.objectContaining({ message: expect.stringContaining("OpenBao is not configured") }) }),
        ]);
    });

    it("runs only the pinned image: any other leaves every Deployment as it is, while the endpoints are still applied", async () => {
        const state = fixture();
        state.externalDnsImage = "registry.k8s.io/external-dns/external-dns:v0.24.0";
        expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
        expect(kube.writes()).toEqual([`APPLY ${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`, `APPLY ${ENDPOINTS}/mail-domain-example-com`]);
        expect(logged("external_dns_image_refused")).toEqual([
            expect.objectContaining({ image: "registry.k8s.io/external-dns/external-dns:v0.24.0", pin: settings.externalDnsImage }),
        ]);
    });

    it("rolls the pod only for credentials its Secret already holds, and comes back while they are still on their way", async () => {
        const state = fixture();
        state.providers[0].secretRef.generation = 2;
        kube.put(`${SECRETS}/mail-dns-cloudflare-main`, {}, { "rapidmx.io/credentials-generation": "1" });
        const r = reconciler();
        expect(await r.reconcile(state)).toMatchObject({ result: "incomplete" });
        const annotation = (): unknown =>
            (kube.objects.get(`${DEPLOYMENTS}/mail-external-dns-cloudflare-main`) as unknown as { spec: { template: { metadata: { annotations: Record<string, string> } } } })
                .spec.template.metadata.annotations["rapidmx.io/credentials-generation"];
        expect(annotation()).toBe("1");
        expect(logged("credentials_pending")).toEqual([expect.objectContaining({ providerUid: "cloudflare-main", generation: 2, secretGeneration: 1 })]);
        kube.put(`${SECRETS}/mail-dns-cloudflare-main`, {}, { "rapidmx.io/credentials-generation": "2" });
        expect(await r.reconcile(state)).toEqual({ result: "done" });
        expect(annotation()).toBe("2");
    });

    it("uses the reference's generation while the Secret doesn't exist yet or carries none", async () => {
        const state = fixture();
        state.providers[0].secretRef.generation = 4;
        await reconciler().reconcile(state);
        const annotation = (): unknown =>
            (kube.objects.get(`${DEPLOYMENTS}/mail-external-dns-cloudflare-main`) as unknown as { spec: { template: { metadata: { annotations: Record<string, string> } } } })
                .spec.template.metadata.annotations["rapidmx.io/credentials-generation"];
        expect(annotation()).toBe("4");
        kube.put(`${SECRETS}/mail-dns-cloudflare-main`, {}, { "rapidmx.io/credentials-generation": "not a number" });
        await reconciler().reconcile(state);
        expect(annotation()).toBe("4");
    });

    it("goes on with the other objects when one fails, logging which, and reports the pass incomplete", async () => {
        const state = fixture();
        state.endpointSets.push({ id: "hosts-cloudflare-main", providerUid: "cloudflare-main", records: [{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.5"] }] });
        kube.failures.set(`APPLY ${ENDPOINTS}/mail-domain-example-com`, new KubeError("boom", 500));
        kube.failures.set(`META ${SECRETS}/`, new KubeError("forbidden", 403, "Forbidden"));
        expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${ENDPOINTS}/mail-hosts-cloudflare-main`)).toBe(true);
        // The Deployment waits for a Secret it could read; nothing is guessed.
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-cloudflare-main`)).toBe(false);
        expect(logged("reconcile_failed")).toEqual([
            expect.objectContaining({ step: "apply", kind: "Deployment", providerUid: "cloudflare-main" }),
            expect.objectContaining({ step: "apply", kind: "DNSEndpoint", name: "mail-domain-example-com" }),
        ]);
    });

    it("logs a failed delete of an ExternalSecret or a removed provider's object and tries again", async () => {
        kube.put(`${EXTERNAL_SECRETS}/mail-dns-gone`, { ...ours("gone"), "rapidmx.io/secret-kind": "dns" });
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`DELETE ${EXTERNAL_SECRETS}/mail-dns-gone`, new KubeError("boom", 500));
        kube.failures.set(`DELETE ${DEPLOYMENTS}/mail-external-dns-old`, new KubeError("boom", 500));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(logged("reconcile_failed").map((l) => [l.step, l.kind, l.providerUid])).toEqual([
            ["delete", "Deployment", "old"],
            ["delete", "ExternalSecret", "gone"],
        ]);
    });

    it("reconciles on every update, coalescing the updates that arrive during a pass, resyncs, and retries with backoff", async () => {
        vi.useFakeTimers();
        const r = reconciler({ resyncMs: 600000, retryMs: 1000, now: Date.now });
        const passes = vi.spyOn(r, "reconcile");
        r.update(fixture());
        r.update(fixture());
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(2);
        // Nothing to do: the next pass is the resync.
        await vi.advanceTimersByTimeAsync(599999);
        expect(passes).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(passes).toHaveBeenCalledTimes(3);
        // Not the writer: try again soon, then less often.
        writable = false;
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1000);
        expect(passes).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(1999);
        expect(passes).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(1);
        expect(passes).toHaveBeenCalledTimes(6);
        writable = true;
        await vi.advanceTimersByTimeAsync(4000);
        expect(passes).toHaveBeenCalledTimes(7);
        // Done again: back to the resync, the backoff reset.
        await vi.advanceTimersByTimeAsync(599999);
        expect(passes).toHaveBeenCalledTimes(7);
        await r.stop();
        await vi.advanceTimersByTimeAsync(600000);
        expect(passes).toHaveBeenCalledTimes(7);
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(7);
    });

    it("waits at most a minute between retries, and passes at once when woken (the Lease was just taken)", async () => {
        vi.useFakeTimers();
        writable = false;
        const r = reconciler({ resyncMs: 600000, retryMs: 40000, now: Date.now });
        const passes = vi.spyOn(r, "reconcile");
        r.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(0);
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(40000);
        expect(passes).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(59999);
        expect(passes).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(passes).toHaveBeenCalledTimes(3);
        writable = true;
        r.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(4);
        expect(kube.writes()).toContain(`APPLY ${ENDPOINTS}/mail-domain-example-com`);
        await r.stop();
    });

    it("comes back when a provider's removal is due, sooner than the resync", async () => {
        vi.useFakeTimers();
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        const r = reconciler({ resyncMs: 600000, providerRemovalDelayMs: 120000, now: Date.now });
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        await vi.advanceTimersByTimeAsync(120000);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(false);
        await r.stop();
    });

    it("lets an unexpected exception out of a pass, which the loop then logs", async () => {
        const state = fixture();
        state.externalDnsImage = "other";
        const r = new Reconciler({
            kube: kube.client,
            settings,
            gate: { mayWrite: () => true },
            log: new Logger("debug", (l) => {
                if (l.includes("external_dns_image_refused")) {
                    throw new Error("the log is broken");
                }
            }),
        });
        await expect(r.reconcile(state)).rejects.toThrow("the log is broken");
    });

    it("stops writing at once and resolves its stop only when the request in flight has been answered", async () => {
        let answer: (() => void) | undefined;
        const apply = kube.client.apply;
        kube.client.apply = async <T>(path: string, body: KubeObject, options: ApplyOptions): Promise<T> => {
            if (path.includes("externalsecrets")) {
                await new Promise<void>((resolve) => (answer = resolve));
            }
            return apply<T>(path, body, options);
        };
        const r = reconciler();
        const passes = vi.spyOn(r, "reconcile");
        r.update(fixture());
        await vi.waitFor(() => expect(answer).toBeDefined());
        let stopped = false;
        const stopping = r.stop().then(() => (stopped = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stopped).toBe(false);
        answer?.();
        await stopping;
        // Nothing after the answered request: the Lease may be released now.
        expect(kube.writes()).toEqual([`APPLY ${EXTERNAL_SECRETS}/mail-dns-cloudflare-main`]);
        await expect(passes.mock.results[0].value).resolves.toEqual({ result: "not_writer" });
        // A stop with nothing under way resolves at once.
        await reconciler().stop();
    });

    it("schedules nothing once stopped during a pass", async () => {
        vi.useFakeTimers();
        const r = reconciler({ resyncMs: 1000 });
        const passes = vi.spyOn(r, "reconcile");
        r.update(fixture());
        r.update(fixture());
        await r.stop();
        await vi.advanceTimersByTimeAsync(5000);
        expect(passes).toHaveBeenCalledTimes(1);
    });

    it("does nothing before it has a desired state, and never lets a pass's exception escape", async () => {
        vi.useFakeTimers();
        const r = reconciler({ resyncMs: 1000 });
        vi.spyOn(r, "reconcile").mockRejectedValueOnce(new Error("unexpected"));
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "pass", error: expect.objectContaining({ message: "unexpected" }) })]);
        await r.stop();
        const idle = reconciler();
        await idle.stop();
        expect(kube.calls).toEqual([]);
    });
});
