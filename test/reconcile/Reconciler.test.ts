import { readFileSync } from "node:fs";
import type { CallOutcome } from "../../src/api/ServerClient.js";
import { parseDesiredState, parseProviderCredentials, type DesiredStateV1, type DnsProviderCredentialsV1 } from "../../src/api/v1.js";
import { KubeError, type ApplyOptions } from "../../src/kube/KubeClient.js";
import { Logger } from "../../src/log.js";
import { credentialsSecret, dnsEndpoint, externalDnsDeployment, type ManifestSettings } from "../../src/reconcile/manifests.js";
import { NotWriterError } from "../../src/reconcile/NotWriterError.js";
import { Reconciler } from "../../src/reconcile/Reconciler.js";

const DEPLOYMENTS = "/apis/apps/v1/namespaces/rapidmx/deployments";
const ENDPOINTS = "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints";
const SECRETS = "/api/v1/namespaces/rapidmx/secrets";
const SECRET = `${SECRETS}/mail-dns-cloudflare-main`;
const DEPLOYMENT = `${DEPLOYMENTS}/mail-external-dns-cloudflare-main`;
const ENDPOINT = `${ENDPOINTS}/mail-domain-example-com`;
const SELECTOR = "labelSelector=app.kubernetes.io%2Fmanaged-by%3Drapidmx-dns-controller%2Capp.kubernetes.io%2Finstance%3Dmail";
const GENERATION = "rapidmx.io/credentials-generation";
/** The uid FakeKube gives a Deployment it was seeded with. */
const OWNER_UID = "uid-mail-external-dns-cloudflare-main";

const settings: ManifestSettings = {
    namespace: "rapidmx",
    fullname: "mail",
    release: "mail",
    externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
    externalDnsServiceAccount: "mail-external-dns",
};

type KubeObject = {
    metadata: { name: string; uid?: string; labels?: Record<string, string>; annotations?: Record<string, string>; generation?: number };
    [key: string]: unknown;
};

/** An in-memory namespace: server-side apply, label-selected lists, metadata-only reads and deletes, with failures on demand. */
class FakeKube {
    objects = new Map<string, KubeObject>();
    calls: string[] = [];
    /** What each apply was sent, in order. */
    applied: { path: string; body: KubeObject }[] = [];
    created = 0;
    /** Leaves the uid out of the answer to an apply, as a broken API server might. */
    anonymous = false;
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

    put(path: string, labels: Record<string, string>, annotations?: Record<string, string>, data?: Record<string, string>): void {
        const name = path.slice(path.lastIndexOf("/") + 1);
        this.objects.set(path, { metadata: { name, uid: `uid-${name}`, labels, ...(annotations ? { annotations } : {}) }, ...(data ? { data } : {}) });
    }

    readonly client = {
        apply: async <T>(path: string, body: KubeObject, options: ApplyOptions): Promise<T> => {
            this.fail(`APPLY ${path}`);
            this.applyOptions.push(options);
            this.applied.push({ path, body: structuredClone(body) });
            const before = this.objects.get(path);
            const changed = JSON.stringify(before?.spec) !== JSON.stringify(body.spec);
            const generation = (before?.metadata.generation ?? 0) + (changed ? 1 : 0);
            const uid = before?.metadata.uid ?? `uid-${++this.created}`;
            const stored = { ...structuredClone(body), metadata: { ...structuredClone(body.metadata), uid, generation } };
            this.objects.set(path, stored);
            const answer = structuredClone(stored);
            if (this.anonymous) {
                delete answer.metadata.uid;
            }
            return answer as T;
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
        // Metadata only, as PartialObjectMetadata: a Secret's data never comes with it.
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

const credentialsText = readFileSync(new URL("../fixtures/api/v1/provider-credentials.json", import.meta.url), "utf8");
const unreadableText = readFileSync(new URL("../fixtures/api/v1/provider-credentials-unreadable.json", import.meta.url), "utf8");
const credentialsFixture = (): DnsProviderCredentialsV1 => parseProviderCredentials(JSON.parse(credentialsText));
const ok = (value: DnsProviderCredentialsV1): CallOutcome<DnsProviderCredentialsV1> => ({ state: "ok", value });
/** The credential the fixture carries: it may be in a Secret's data, and nowhere else the controller writes or logs. */
const TOKEN = "cf-example-token-not-a-real-secret";
const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** The fixture's state with its provider's credentials at `generation`. */
function at(generation: number): DesiredStateV1 {
    const state = fixture();
    state.providers[0].credentials = { keys: ["apiToken"], generation };
    return state;
}

/** The server's answer for the fixture's provider at `generation`. */
const answer = (generation: number, token = TOKEN): CallOutcome<DnsProviderCredentialsV1> =>
    ok({ ...credentialsFixture(), generation, values: { apiToken: token } });

const ours = (provider: string): Record<string, string> => ({
    "app.kubernetes.io/name": "external-dns",
    "app.kubernetes.io/instance": "mail",
    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
    "rapidmx.io/dns-provider": provider,
});

/** The labels of a Secret this controller wrote for `provider`. */
const oursSecret = (provider: string): Record<string, string> => ({ ...ours(provider), "rapidmx.io/secret-kind": "dns" });

describe("Reconciler", () => {
    let kube: FakeKube;
    let lines: string[];
    let writable: boolean;
    let clock: number;
    let credentials: CallOutcome<DnsProviderCredentialsV1>;
    let fetched: string[];

    function reconciler(extra: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}): Reconciler {
        return new Reconciler({
            kube: kube.client,
            server: {
                providerCredentials: async (uid) => {
                    fetched.push(uid);
                    return credentials;
                },
            },
            settings,
            gate: { mayWrite: () => writable },
            log: new Logger("debug", (l) => lines.push(l)),
            now: () => clock,
            ...extra,
        });
    }

    const logged = (msg: string): Record<string, unknown>[] => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);

    /** The credentials generation the pod template of the provider's Deployment carries. */
    const rolledTo = (): unknown =>
        (kube.objects.get(DEPLOYMENT) as unknown as { spec: { template: { metadata: { annotations?: Record<string, string> } } } }).spec.template.metadata
            .annotations?.[GENERATION];

    /** The Secret the controller wrote before: at `generation`, with a recognisable data value, owned by the Deployment already there. */
    const secretAt = (generation: number, owner = OWNER_UID): void => {
        kube.put(DEPLOYMENT, ours("cloudflare-main"));
        kube.put(SECRET, oursSecret("cloudflare-main"), { [GENERATION]: String(generation) }, { apiToken: b64("old-token") });
        (kube.objects.get(SECRET) as unknown as { metadata: { ownerReferences: unknown } }).metadata.ownerReferences = [{ kind: "Deployment", name: "mail-external-dns-cloudflare-main", uid: owner }];
    };

    beforeEach(() => {
        kube = new FakeKube();
        lines = [];
        writable = true;
        clock = Date.parse("2026-10-28T10:00:00Z");
        fetched = [];
        credentials = ok(credentialsFixture());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("applies each provider's Deployment, then its Secret from the credentials the server sends, then each endpoint set, with server-side apply as its own field manager", async () => {
        const state = fixture();
        expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${SECRET}`, `APPLY ${ENDPOINT}`]);
        expect(kube.applyOptions).toEqual(Array(3).fill({ fieldManager: "rapidmx-dns-controller", force: true }));
        expect(fetched).toEqual(["cloudflare-main"]);
        const stored = (path: string): unknown => {
            const { metadata, ...rest } = kube.objects.get(path);
            const { generation: _generation, uid: _uid, ...meta } = metadata;
            return { ...rest, metadata: meta };
        };
        // The Secret is owned by the Deployment the API server had just created, and holds what the server sent.
        const uid = kube.objects.get(DEPLOYMENT).metadata.uid;
        expect(stored(SECRET)).toEqual(credentialsSecret(state.providers[0], { apiToken: TOKEN }, settings, uid));
        expect(stored(DEPLOYMENT)).toEqual(externalDnsDeployment(state.providers[0], state.ownerId, settings, 1));
        expect(stored(ENDPOINT)).toEqual(dnsEndpoint(state.endpointSets[0], "cloudflare", settings));
        expect(logged("credentials_written")).toEqual([expect.objectContaining({ providerUid: "cloudflare-main", generation: 1 })]);
        // Lists select only what this release's controller manages; nothing is an ExternalSecret any more.
        expect(kube.calls).toContain(`GET ${ENDPOINTS}?${SELECTOR}`);
        expect(kube.calls).toContain(`GET ${DEPLOYMENTS}?${SELECTOR}`);
        expect(kube.calls.some((c) => c.includes("externalsecrets"))).toBe(false);
        // The credential is in the Secret's data only.
        expect(lines.join("\n")).not.toContain(TOKEN);
    });

    it("is idempotent: a second pass applies the same objects, fetches no credentials and deletes nothing", async () => {
        const r = reconciler();
        await r.reconcile(fixture());
        const before = structuredClone([...kube.objects.entries()]);
        kube.calls = [];
        fetched = [];
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        // The Secret already holds the generation: nothing to fetch, nothing to write.
        expect(fetched).toEqual([]);
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
        expect([...kube.objects.entries()]).toEqual(before);
    });

    it("writes nothing while it may not write", async () => {
        writable = false;
        expect(await reconciler().reconcile(fixture())).toEqual({ result: "not_writer" });
        expect(kube.calls).toEqual([]);
        expect(fetched).toEqual([]);
    });

    it("checks that it may write immediately before every write, stopping the pass the moment it may not", async () => {
        let allowed = 2;
        const r = reconciler({ gate: { mayWrite: () => allowed-- > 0 } });
        // The start of the pass and the Deployment's apply are allowed; the fetch and the Secret are not.
        expect(await r.reconcile(fixture())).toEqual({ result: "not_writer" });
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`]);
    });

    it("fetches no credentials unless it may write at that moment, and writes no Secret it may not", async () => {
        let allowed = 2;
        await reconciler({ gate: { mayWrite: () => allowed-- > 0 } }).reconcile(fixture());
        expect(fetched).toEqual([]);
        expect(kube.objects.has(SECRET)).toBe(false);
        // Lost between the fetch and the Secret's apply: what was fetched is dropped unwritten.
        kube = new FakeKube();
        allowed = 3;
        expect(await reconciler({ gate: { mayWrite: () => allowed-- > 0 } }).reconcile(fixture())).toEqual({ result: "not_writer" });
        expect(fetched).toEqual(["cloudflare-main"]);
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`]);
    });

    it("refuses a whole state it can't publish safely, before any call", async () => {
        const bad = (patch: (s: DesiredStateV1) => void): DesiredStateV1 => {
            const s = fixture();
            patch(s);
            return s;
        };
        const r = reconciler();
        const states = [
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
            // A field name becomes a Secret key and an environment reference: nothing but letters, digits, '-' and '_'.
            bad((s) => (s.providers[0].credentials.keys = ["apiToken", "a/b"])),
            bad((s) => (s.providers[0].credentials.keys = ["apiToken", "a b"])),
            bad((s) => (s.providers[0].credentials.keys = ["x".repeat(254)])),
        ];
        for (const state of states) {
            expect(await r.reconcile(state)).toMatchObject({ result: "refused" });
        }
        expect(kube.calls).toEqual([]);
        expect(fetched).toEqual([]);
        expect(logged("desired_state_unpublishable")).toHaveLength(states.length);
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

    describe("a deleted provider's instance, which runs for one more interval", () => {
        const PARENT = "mail-external-dns-cloudflare-main";
        const args = (name: string): string[] =>
            (kube.objects.get(`${DEPLOYMENTS}/${name}`) as unknown as { spec: { template: { spec: { containers: { args: string[] }[] } } } }).spec.template.spec
                .containers[0].args;
        /** The Deployment a deleted config's instance still has, filtered to `zones` as the controller made it. */
        const instance = (uid: string, zones: string[]): void => {
            kube.put(`${DEPLOYMENTS}/mail-external-dns-${uid}`, ours(uid));
            (kube.objects.get(`${DEPLOYMENTS}/mail-external-dns-${uid}`) as unknown as Record<string, unknown>).spec = {
                // A container without arguments filters nothing.
                template: { spec: { containers: [{}, { args: ["--source=crd", ...zones.map((zone) => `--domain-filter=${zone}`)] }] } },
            };
        };

        it("keeps the instance of the parent zone out of the deleted nested config's zone until that instance is gone", async () => {
            // sub.example.com was a config of its own; deleted, its domain moved to the parent's config.
            instance("sub", ["sub.example.com"]);
            const r = reconciler({ providerRemovalDelayMs: 120000 });
            expect(await r.reconcile(fixture())).toEqual({ result: "done", nextAt: clock + 120000 });
            // Else the nested instance, still syncing under the shared owner id, deletes what the parent publishes there.
            expect(args(PARENT)).toContain("--exclude-domains=sub.example.com");
            clock += 120000;
            expect(await r.reconcile(fixture())).toEqual({ result: "done" });
            expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-sub`)).toBe(false);
            // The pass that follows the removal is the parent's, without the exclusion.
            expect(await r.reconcile(fixture())).toEqual({ result: "done" });
            expect(args(PARENT).some((a) => a.startsWith("--exclude-domains="))).toBe(false);
        });

        it("asks for that pass itself, at once, and for no other", async () => {
            vi.useFakeTimers();
            instance("sub", ["sub.example.com"]);
            instance("unrelated", ["example.net"]);
            const r = reconciler({ resyncMs: 600000, providerRemovalDelayMs: 120000, now: Date.now });
            const passes = vi.spyOn(r, "reconcile");
            r.update(fixture());
            await vi.advanceTimersByTimeAsync(0);
            expect(passes).toHaveBeenCalledTimes(1);
            expect(args(PARENT)).toContain("--exclude-domains=sub.example.com");
            expect(args(PARENT)).not.toContain("--exclude-domains=example.net");
            await vi.advanceTimersByTimeAsync(120000);
            // The removal pass, then the parent's without the exclusion.
            expect(passes).toHaveBeenCalledTimes(3);
            expect(args(PARENT).some((a) => a.startsWith("--exclude-domains="))).toBe(false);
            expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-unrelated`)).toBe(false);
            await r.stop();
        });

        it("asks for no further pass when the removal of an instance outside every zone is all there was", async () => {
            vi.useFakeTimers();
            instance("unrelated", ["example.net"]);
            const r = reconciler({ resyncMs: 600000, providerRemovalDelayMs: 0, now: Date.now });
            const passes = vi.spyOn(r, "reconcile");
            r.update(fixture());
            await vi.advanceTimersByTimeAsync(0);
            expect(passes).toHaveBeenCalledTimes(1);
            expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-unrelated`)).toBe(false);
            await r.stop();
        });

        it("keeps the zone of a deleted config out of a new config that has the same zone", async () => {
            instance("old", ["example.com"]);
            const state = fixture();
            expect(await reconciler({ providerRemovalDelayMs: 120000 }).reconcile(state)).toMatchObject({ result: "done" });
            expect(args(PARENT)).toContain("--exclude-domains=example.com");
        });

        it("applies no instance when it can't tell which deleted instances are still there", async () => {
            kube.failures.set(`GET ${DEPLOYMENTS}?`, new KubeError("boom", 500));
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(DEPLOYMENT)).toBe(false);
            expect(kube.writes().some((w) => w.includes("/deployments/"))).toBe(false);
            // The endpoints are the providers', not the instances': they still are applied.
            expect(kube.objects.has(ENDPOINT)).toBe(true);
        });
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

    describe("credentials", () => {
        it("runs the instance on the config's generation while its Secret isn't there yet, and writes the Secret right after the Deployment", async () => {
            credentials = answer(4);
            expect(await reconciler().reconcile(at(4))).toEqual({ result: "done" });
            expect(rolledTo()).toBe("4");
            expect(kube.applied.filter((a) => a.path === DEPLOYMENT)).toHaveLength(1);
            expect(kube.objects.get(SECRET).metadata.annotations).toEqual({ [GENERATION]: "4" });
        });

        it("rewrites a Secret whose generation differs and rolls the pod only once the Secret holds the new credentials", async () => {
            secretAt(1);
            credentials = answer(2, "new-token");
            expect(await reconciler().reconcile(at(2))).toEqual({ result: "done" });
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${SECRET}`, `APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
            // The first Deployment apply still carries the generation the Secret held; the second, the one it now holds.
            const annotations = kube.applied
                .filter((a) => a.path === DEPLOYMENT)
                .map((a) => (a.body as unknown as { spec: { template: { metadata: { annotations: Record<string, string> } } } }).spec.template.metadata.annotations[GENERATION]);
            expect(annotations).toEqual(["1", "2"]);
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("new-token") });
            expect(kube.objects.get(SECRET).metadata.annotations).toEqual({ [GENERATION]: "2" });
            expect(lines.join("\n")).not.toContain("new-token");
        });

        it("fetches again for a Secret that carries no usable generation", async () => {
            kube.put(SECRET, oursSecret("cloudflare-main"), { [GENERATION]: "not a number" }, { apiToken: b64("old-token") });
            expect(await reconciler().reconcile(fixture())).toEqual({ result: "done" });
            expect(fetched).toEqual(["cloudflare-main"]);
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64(TOKEN) });
            kube.put(SECRET, oursSecret("cloudflare-main"), undefined, { apiToken: b64("old-token") });
            fetched = [];
            await reconciler().reconcile(fixture());
            expect(fetched).toEqual(["cloudflare-main"]);
        });

        it("rolls the pod only after the Secret is rewritten when the Secret has lost its generation", async () => {
            secretAt(1);
            delete (kube.objects.get(SECRET).metadata as { annotations?: unknown }).annotations;
            credentials = answer(2, "new-token");
            expect(await reconciler().reconcile(at(2))).toEqual({ result: "done" });
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${SECRET}`, `APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
            // The first apply says nothing the server's generations could match; only the apply after the write names the new one.
            const annotations = kube.applied
                .filter((a) => a.path === DEPLOYMENT)
                .map((a) => (a.body as unknown as { spec: { template: { metadata: { annotations: Record<string, string> } } } }).spec.template.metadata.annotations[GENERATION]);
            expect(annotations).toEqual(["-1", "2"]);
            expect(rolledTo()).toBe("2");
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("new-token") });
        });

        it("writes the Secret again for the Deployment now owning it, when the Deployment was recreated with another uid", async () => {
            secretAt(2, "uid-of-the-deleted-deployment");
            credentials = answer(2, "fresh-token");
            expect(await reconciler().reconcile(at(2))).toEqual({ result: "done" });
            expect(fetched).toEqual(["cloudflare-main"]);
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${SECRET}`, `APPLY ${ENDPOINT}`]);
            const owners = (kube.objects.get(SECRET).metadata as unknown as { ownerReferences: { uid: string }[] }).ownerReferences;
            expect(owners).toEqual([expect.objectContaining({ uid: OWNER_UID })]);
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("fresh-token") });
            // The credentials are the same generation: the pod keeps running.
            expect(rolledTo()).toBe("2");
        });

        it("writes the Secret again when no Deployment owns it, and keeps the old one when that fetch fails", async () => {
            secretAt(2);
            // Another kind with the uid, and a Deployment without one, own nothing here.
            (kube.objects.get(SECRET) as unknown as { metadata: { ownerReferences?: unknown } }).metadata.ownerReferences = [
                { kind: "ReplicaSet", uid: OWNER_UID },
                { kind: "Deployment" },
            ];
            credentials = { state: "unavailable", error: "HTTP 503" };
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("old-token") });
            credentials = answer(2);
            expect(await reconciler().reconcile(at(2))).toEqual({ result: "done" });
            expect((kube.objects.get(SECRET).metadata as unknown as { ownerReferences: { uid: string }[] }).ownerReferences[0].uid).toBe(OWNER_UID);
        });

        it("has no uid to compare a Secret's owner with when the API server answers the Deployment without one", async () => {
            secretAt(2, "uid-of-the-deleted-deployment");
            kube.anonymous = true;
            expect(await reconciler().reconcile(at(2))).toEqual({ result: "done" });
            expect(fetched).toEqual([]);
        });

        it.each([
            ["the server can't be reached", { state: "unavailable", error: "HTTP 503" } as const, "HTTP 503"],
            [
                "the server no longer speaks v1 (or the config is gone)",
                { state: "incompatible", reason: "the server has no dns.rapidmx.io/v1 DNS API (404)" } as const,
                "the server has no dns.rapidmx.io/v1 DNS API (404)",
            ],
            ["the answer is malformed", { state: "invalid", error: "'values.apiToken' must be text" } as const, "'values.apiToken' must be text"],
        ])("keeps the Secret and the pod as they are, and tries again, when %s", async (_why, outcome, detail) => {
            secretAt(1);
            credentials = outcome;
            const before = structuredClone(kube.objects.get(SECRET));
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(SECRET)).toEqual(before);
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
            expect(rolledTo()).toBe("1");
            expect(logged("credentials_fetch_failed")).toEqual([
                expect.objectContaining({ level: "warn", providerUid: "cloudflare-main", generation: 2, state: outcome.state, detail }),
            ]);
        });

        it("runs the instance on the config's generation while the Secret is missing and the credentials can't be fetched", async () => {
            credentials = { state: "unavailable", error: "fetch failed" };
            expect(await reconciler().reconcile(at(3))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(SECRET)).toBe(false);
            expect(rolledTo()).toBe("3");
        });

        it("keeps the Secret when the server could not decrypt a field, naming it and never what it did read", async () => {
            const state = fixture();
            state.providers[0] = {
                uid: "aws-main",
                type: "route53",
                zones: ["example.com"],
                options: { region: "eu-west-1" },
                credentials: { keys: ["accessKeyId", "secretAccessKey"], generation: 2 },
                enabled: true,
            };
            state.endpointSets = [];
            kube.put(`${SECRETS}/mail-dns-aws-main`, oursSecret("aws-main"), { [GENERATION]: "1" }, { accessKeyId: b64("old") });
            credentials = ok(parseProviderCredentials(JSON.parse(unreadableText)));
            const before = structuredClone(kube.objects.get(`${SECRETS}/mail-dns-aws-main`));
            expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(`${SECRETS}/mail-dns-aws-main`)).toEqual(before);
            expect(logged("credentials_unreadable")).toEqual([
                expect.objectContaining({ level: "warn", providerUid: "aws-main", generation: 2, fields: ["secretAccessKey"] }),
            ]);
            expect(lines.join("\n")).not.toContain("AKIAEXAMPLEEXAMPLE00");
        });

        it("keeps the Secret when a field the state lists is missing from the answer, even if the server named none unreadable", async () => {
            secretAt(1);
            credentials = ok({ ...credentialsFixture(), generation: 2, values: {} });
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("old-token") });
            expect(logged("credentials_unreadable")).toEqual([expect.objectContaining({ fields: ["apiToken"] })]);
        });

        it("keeps the Secret when the server names a field unreadable that it also sent", async () => {
            secretAt(1);
            credentials = ok({ ...credentialsFixture(), generation: 2, unreadable: ["extra"] });
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("old-token") });
            expect(logged("credentials_unreadable")).toEqual([expect.objectContaining({ fields: ["extra"] })]);
        });

        it.each([
            ["older", 1],
            ["newer", 3],
        ])("writes nothing from an answer at a generation (%s) other than the one the state wants", async (_which, generation) => {
            secretAt(1);
            credentials = answer(generation, "stale-token");
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("old-token") });
            expect(rolledTo()).toBe("1");
            expect(logged("credentials_stale")).toEqual([expect.objectContaining({ level: "warn", providerUid: "cloudflare-main", generation: 2, answered: generation })]);
            expect(lines.join("\n")).not.toContain("stale-token");
        });

        it("writes nothing from an answer about another provider", async () => {
            credentials = ok({ ...credentialsFixture(), providerUid: "someone-else" });
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(SECRET)).toBe(false);
            expect(logged("credentials_fetch_failed")).toEqual([
                expect.objectContaining({ providerUid: "cloudflare-main", state: "invalid", detail: "the answer is about another provider" }),
            ]);
        });

        it("never overwrites, or runs an instance on, a Secret of that name that isn't its own", async () => {
            kube.put(SECRET, { "app.kubernetes.io/managed-by": "Helm" }, { [GENERATION]: "1" }, { apiToken: b64("someone else's") });
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(fetched).toEqual([]);
            expect(kube.writes()).toEqual([`APPLY ${ENDPOINT}`]);
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64("someone else's") });
            expect(logged("reconcile_failed")).toEqual([
                expect.objectContaining({
                    step: "read",
                    kind: "Secret",
                    providerUid: "cloudflare-main",
                    error: expect.objectContaining({ message: expect.stringContaining("not this controller's") }),
                }),
            ]);
        });

        it("holds a Secret to three labels: this controller, the dns kind and this provider", async () => {
            for (const labels of [
                { ...oursSecret("cloudflare-main"), "app.kubernetes.io/managed-by": "Helm" },
                { ...oursSecret("cloudflare-main"), "rapidmx.io/secret-kind": "other" },
                { ...oursSecret("cloudflare-main"), "rapidmx.io/dns-provider": "second" },
            ]) {
                kube.objects.clear();
                kube.put(SECRET, labels, { [GENERATION]: "1" });
                expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            }
            // A Secret with no labels at all is no one's either.
            kube.objects.set(SECRET, { metadata: { name: "mail-dns-cloudflare-main" } });
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(fetched).toEqual([]);
        });

        it("leaves the Deployment alone and goes on when it can't read the Secret", async () => {
            kube.failures.set(`META ${SECRET}`, new KubeError("forbidden", 403, "Forbidden"));
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(kube.writes()).toEqual([`APPLY ${ENDPOINT}`]);
            expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "read", kind: "Secret", providerUid: "cloudflare-main" })]);
        });

        it("logs a Secret it can't write without the credentials, and does not roll the pod", async () => {
            secretAt(1);
            credentials = answer(2, "new-token");
            kube.failures.set(`APPLY ${SECRET}`, new KubeError("boom", 500));
            expect(await reconciler().reconcile(at(2))).toMatchObject({ result: "incomplete" });
            expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "apply", kind: "Secret", providerUid: "cloudflare-main" })]);
            expect(rolledTo()).toBe("1");
            expect(kube.writes()).toContain(`APPLY ${ENDPOINT}`);
            expect(lines.join("\n")).not.toContain("new-token");
        });

        it("writes the Secret of a disabled config too, so it is there when the config is enabled", async () => {
            const state = fixture();
            state.providers[0].enabled = false;
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64(TOKEN) });
            expect((kube.objects.get(DEPLOYMENT) as unknown as { spec: { replicas: number } }).spec.replicas).toBe(0);
        });

        it("builds Azure's azure.json itself from the tenant and the fetched client", async () => {
            const state = fixture();
            state.providers[0] = {
                uid: "azure-main",
                type: "azure",
                zones: ["example.com"],
                options: { tenantId: "11111111-2222-3333-4444-555555555555", subscriptionId: "s", resourceGroup: "r" },
                credentials: { keys: ["clientId", "clientSecret"], generation: 5 },
                enabled: true,
            };
            state.endpointSets = [];
            credentials = ok({ ...credentialsFixture(), providerUid: "azure-main", generation: 5, values: { clientId: "client-1", clientSecret: "client-secret" } });
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            const secret = kube.objects.get(`${SECRETS}/mail-dns-azure-main`);
            expect(Object.keys(secret.data as object)).toEqual(["azure.json"]);
            expect(JSON.parse(Buffer.from((secret.data as Record<string, string>)["azure.json"], "base64").toString("utf8"))).toEqual({
                tenantId: "11111111-2222-3333-4444-555555555555",
                aadClientId: "client-1",
                aadClientSecret: "client-secret",
            });
            expect(lines.join("\n")).not.toContain("client-secret");
        });

        it("logs a config whose Azure tenant isn't a GUID and writes nothing for it", async () => {
            const state = fixture();
            state.providers[0] = {
                uid: "azure-main",
                type: "azure",
                zones: ["example.com"],
                options: { tenantId: "{{ .x }}" },
                credentials: { keys: ["clientId", "clientSecret"], generation: 1 },
                enabled: true,
            };
            state.endpointSets = [];
            credentials = ok({ ...credentialsFixture(), providerUid: "azure-main", values: { clientId: "client-1", clientSecret: "client-secret" } });
            expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(`${SECRETS}/mail-dns-azure-main`)).toBe(false);
            expect(logged("reconcile_failed")).toEqual([
                expect.objectContaining({ kind: "Secret", providerUid: "azure-main", error: expect.objectContaining({ message: "'tenantId' must be a GUID" }) }),
            ]);
            expect(lines.join("\n")).not.toContain("client-secret");
        });

        it("gives a config without credentials no Secret, and deletes the one it wrote before", async () => {
            const state = fixture();
            delete state.providers[0].credentials;
            // Nothing there: nothing to delete, nothing to fetch.
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
            expect(fetched).toEqual([]);
            expect(rolledTo()).toBeUndefined();
            kube.calls = [];
            secretAt(1);
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `DELETE ${SECRET}`, `APPLY ${ENDPOINT}`]);
            expect(kube.objects.has(SECRET)).toBe(false);
            expect(fetched).toEqual([]);
        });

        it("keeps the Secret it wrote while the image is refused, since the Deployment that refers to it can't be updated", async () => {
            const state = fixture();
            state.externalDnsImage = "registry.k8s.io/external-dns/external-dns:v0.24.0";
            delete state.providers[0].credentials;
            secretAt(1);
            expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(SECRET)).toBe(true);
            expect(kube.writes()).toEqual([`APPLY ${ENDPOINT}`]);
            expect(logged("secret_delete_deferred")).toEqual([expect.objectContaining({ providerUid: "cloudflare-main" })]);
            // Once the pin matches again the Deployment drops its references and the Secret goes.
            state.externalDnsImage = settings.externalDnsImage;
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            expect(kube.objects.has(SECRET)).toBe(false);
        });

        it("leaves a Secret that isn't its own alone when the config has no credentials", async () => {
            const state = fixture();
            delete state.providers[0].credentials;
            kube.put(SECRET, { "app.kubernetes.io/managed-by": "Helm" }, undefined, { x: "y" });
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
            expect(kube.objects.has(SECRET)).toBe(true);
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${ENDPOINT}`]);
        });

        it("fails the config, not the pass, when the Secret it should delete can't be", async () => {
            const state = fixture();
            delete state.providers[0].credentials;
            secretAt(1);
            kube.failures.set(`DELETE ${SECRET}`, new KubeError("boom", 500));
            expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
            expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "delete", kind: "Secret", providerUid: "cloudflare-main" })]);
            expect(kube.writes()).toContain(`APPLY ${ENDPOINT}`);
        });

        it("tolerates a Secret that is gone by the time it deletes it", async () => {
            const state = fixture();
            delete state.providers[0].credentials;
            secretAt(1);
            kube.failures.set(`DELETE ${SECRET}`, new KubeError("not found", 404, "NotFound"));
            expect(await reconciler().reconcile(state)).toEqual({ result: "done" });
        });

        it("refuses to write a Secret owned by a Deployment the API server gave no uid", async () => {
            kube.anonymous = true;
            expect(await reconciler().reconcile(fixture())).toMatchObject({ result: "incomplete" });
            expect(fetched).toEqual([]);
            expect(kube.objects.has(SECRET)).toBe(false);
            expect(logged("reconcile_failed")).toEqual([
                expect.objectContaining({ kind: "Secret", providerUid: "cloudflare-main", error: expect.objectContaining({ message: expect.stringContaining("no uid") }) }),
            ]);
        });
    });

    describe("when the image is refused", () => {
        const refused = (): DesiredStateV1 => {
            const state = fixture();
            state.externalDnsImage = "registry.k8s.io/external-dns/external-dns:v0.24.0";
            return state;
        };

        it("runs only the pinned image: any other leaves every Deployment as it is, while the endpoints are still applied", async () => {
            expect(await reconciler().reconcile(refused())).toMatchObject({ result: "incomplete" });
            expect(kube.objects.has(DEPLOYMENT)).toBe(false);
            expect(kube.writes()).toEqual([`APPLY ${ENDPOINT}`]);
            expect(logged("external_dns_image_refused")).toEqual([
                expect.objectContaining({ image: "registry.k8s.io/external-dns/external-dns:v0.24.0", pin: settings.externalDnsImage }),
            ]);
        });

        it("waits to write a Secret nothing owns yet: no fetch without a Deployment to own it", async () => {
            await reconciler().reconcile(refused());
            expect(fetched).toEqual([]);
            expect(logged("credentials_deferred")).toEqual([expect.objectContaining({ providerUid: "cloudflare-main" })]);
        });

        it("still writes the Secret of an instance that exists, owned by it, and leaves the instance as it is", async () => {
            kube.put(DEPLOYMENT, ours("cloudflare-main"));
            const before = structuredClone(kube.objects.get(DEPLOYMENT));
            expect(await reconciler().reconcile(refused())).toMatchObject({ result: "incomplete" });
            expect(kube.writes()).toEqual([`APPLY ${SECRET}`, `APPLY ${ENDPOINT}`]);
            expect(kube.objects.get(DEPLOYMENT)).toEqual(before);
            expect((kube.objects.get(SECRET).metadata as unknown as { ownerReferences: { uid: string }[] }).ownerReferences[0].uid).toBe(
                "uid-mail-external-dns-cloudflare-main"
            );
        });

        it("logs an instance it can't read the uid of", async () => {
            kube.put(DEPLOYMENT, ours("cloudflare-main"));
            kube.failures.set(`META ${DEPLOYMENT}`, new KubeError("boom", 500));
            expect(await reconciler().reconcile(refused())).toMatchObject({ result: "incomplete" });
            expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "read", kind: "Deployment", providerUid: "cloudflare-main" })]);
            kube.failures.clear();
            delete kube.objects.get(DEPLOYMENT).metadata.uid;
            lines.length = 0;
            expect(await reconciler().reconcile(refused())).toMatchObject({ result: "incomplete" });
            expect(logged("reconcile_failed")).toEqual([
                expect.objectContaining({ kind: "Deployment", error: expect.objectContaining({ message: expect.stringContaining("no uid") }) }),
            ]);
        });
    });

    it("removes a deleted provider's instance one interval after its endpoints, with its labelled Secret first", async () => {
        kube.put(`${ENDPOINTS}/mail-hosts-old`, ours("old"));
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.put(`${SECRETS}/mail-dns-old`, oursSecret("old"));
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
        expect(kube.writes().filter((w) => w.startsWith("DELETE"))).toEqual([`DELETE ${SECRETS}/mail-dns-old`, `DELETE ${DEPLOYMENTS}/mail-external-dns-old`]);
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
        kube.put(`${SECRETS}/mail-dns-old`, oursSecret("old"));
        kube.failures.set(`META ${SECRETS}/mail-dns-old`, new KubeError("forbidden", 403, "Forbidden"));
        const r = reconciler({ providerRemovalDelayMs: 0 });
        expect(await r.reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "delete", kind: "Secret", providerUid: "old" })]);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        kube.failures.clear();
        kube.failures.set(`DELETE ${SECRETS}/mail-dns-old`, new KubeError("boom", 500));
        expect(await r.reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        // Nothing but the instance points at the Secret: the next pass finds it and finishes.
        kube.failures.clear();
        expect(await r.reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.objects.has(`${SECRETS}/mail-dns-old`)).toBe(false);
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(false);
    });

    it("never lists Secrets: one whose instance is gone leaves with it through its ownerReference, not by a search", async () => {
        kube.put(`${SECRETS}/mail-dns-old`, oursSecret("old"));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toEqual({ result: "done" });
        expect(kube.objects.has(`${SECRETS}/mail-dns-old`)).toBe(true);
        expect(kube.calls.some((c) => c.startsWith(`GET ${SECRETS}`))).toBe(false);
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
        back.providers.push({ ...back.providers[0], uid: "old", zones: ["example.org"], credentials: undefined, type: "route53" });
        expect(await r.reconcile(back)).toEqual({ result: "done" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
    });

    it("removes nothing when it can't list what it manages", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`GET ${ENDPOINTS}?`, new KubeError("the server could not find the requested resource", 404, "NotFound"));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${DEPLOYMENTS}/mail-external-dns-old`)).toBe(true);
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "list", kind: "DNSEndpoint" })]);
        kube.failures.clear();
        kube.failures.set(`GET ${DEPLOYMENTS}?`, new KubeError("boom", 500));
        lines.length = 0;
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(logged("reconcile_failed")).toEqual([expect.objectContaining({ step: "list", kind: "Deployment" })]);
    });

    it("goes on with the other objects when one fails, logging which, and reports the pass incomplete", async () => {
        const state = fixture();
        state.endpointSets.push({ id: "hosts-cloudflare-main", providerUid: "cloudflare-main", records: [{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.5"] }] });
        kube.failures.set(`APPLY ${ENDPOINT}`, new KubeError("boom", 500));
        kube.failures.set(`META ${SECRETS}/`, new KubeError("forbidden", 403, "Forbidden"));
        expect(await reconciler().reconcile(state)).toMatchObject({ result: "incomplete" });
        expect(kube.objects.has(`${ENDPOINTS}/mail-hosts-cloudflare-main`)).toBe(true);
        // The Deployment waits for a Secret it could read; nothing is guessed.
        expect(kube.objects.has(DEPLOYMENT)).toBe(false);
        expect(logged("reconcile_failed")).toEqual([
            expect.objectContaining({ step: "read", kind: "Secret", providerUid: "cloudflare-main" }),
            expect.objectContaining({ step: "apply", kind: "DNSEndpoint", name: "mail-domain-example-com" }),
        ]);
    });

    it("logs a failed delete of a removed provider's instance and tries again", async () => {
        kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
        kube.failures.set(`DELETE ${DEPLOYMENTS}/mail-external-dns-old`, new KubeError("boom", 500));
        expect(await reconciler({ providerRemovalDelayMs: 0 }).reconcile(fixture())).toMatchObject({ result: "incomplete" });
        expect(logged("reconcile_failed").map((l) => [l.step, l.kind, l.providerUid])).toEqual([["delete", "Deployment", "old"]]);
    });

    describe("operations", () => {
        let runs: { state: DesiredStateV1; writable: boolean }[];
        let outcome: { pending: boolean; nextAt?: number } | Error;

        function withOperations(extra: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}): Reconciler {
            return reconciler({
                operations: {
                    run: async (state, mayWrite) => {
                        runs.push({ state, writable: mayWrite() });
                        if (outcome instanceof Error) {
                            throw outcome;
                        }
                        return outcome;
                    },
                },
                ...extra,
            });
        }

        beforeEach(() => {
            runs = [];
            outcome = { pending: false };
        });

        it("runs them after the endpoints are applied and pruned, with the state and the writer's gate", async () => {
            const state = fixture();
            kube.put(`${ENDPOINTS}/mail-domain-gone-com`, ours("cloudflare-main"));
            expect(await withOperations().reconcile(state)).toEqual({ result: "done" });
            expect(runs).toEqual([{ state, writable: true }]);
            // Everything the operations may depend on was written before they ran.
            expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`, `APPLY ${SECRET}`, `APPLY ${ENDPOINT}`, `DELETE ${ENDPOINTS}/mail-domain-gone-com`]);
        });

        it("ends the pass incomplete while an operation is still on its way, and comes back when the next step is due", async () => {
            outcome = { pending: true, nextAt: clock + 5000 };
            expect(await withOperations().reconcile(fixture())).toEqual({ result: "incomplete", nextAt: clock + 5000 });
            // A deleted provider's removal due sooner wins, and so does the operations' when it is sooner.
            kube.put(`${DEPLOYMENTS}/mail-external-dns-old`, ours("old"));
            expect(await withOperations({ providerRemovalDelayMs: 1000 }).reconcile(fixture())).toEqual({ result: "incomplete", nextAt: clock + 1000 });
            expect(await withOperations({ providerRemovalDelayMs: 60000 }).reconcile(fixture())).toEqual({ result: "incomplete", nextAt: clock + 5000 });
            outcome = { pending: true };
            expect(await withOperations().reconcile(fixture())).toMatchObject({ result: "incomplete" });
        });

        it("hands the operations a gate that closes when the reconciler stops, so a stopping reconciler writes nothing more", async () => {
            const seen: boolean[] = [];
            const r: Reconciler = reconciler({
                operations: {
                    run: async (_state, mayWrite) => {
                        seen.push(mayWrite());
                        void r.stop();
                        seen.push(mayWrite());
                        return { pending: false };
                    },
                },
            });
            await r.reconcile(fixture());
            expect(seen).toEqual([true, false]);
        });

        it("logs an operation pass that fails and still ends the others, the pass incomplete", async () => {
            outcome = new KubeError("unavailable", 503);
            expect(await withOperations().reconcile(fixture())).toEqual({ result: "incomplete" });
            expect(logged("reconcile_failed").map((l) => [l.step, l.kind])).toEqual([["run", "Operation"]]);
        });

        it("ends the pass as not the writer when the operations lose the right to write", async () => {
            outcome = new NotWriterError();
            expect(await withOperations().reconcile(fixture())).toEqual({ result: "not_writer" });
        });

        it("runs no operation while the image pin refuses the desired state, and when it refuses the state whole or may not write", async () => {
            const state = fixture();
            state.externalDnsImage = "other";
            expect(await withOperations().reconcile(state)).toEqual({ result: "incomplete" });
            state.providers.push({ ...state.providers[0] });
            expect(await withOperations().reconcile(state)).toEqual({ result: "refused" });
            writable = false;
            expect(await withOperations().reconcile(fixture())).toEqual({ result: "not_writer" });
            expect(runs).toEqual([]);
        });

        it("leaves the temporary endpoints of operations to the runner: they are not regular endpoints to prune", async () => {
            kube.put(`${ENDPOINTS}/mail-op-71a0ef7195df4865`, {
                "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                "app.kubernetes.io/instance": "mail",
                "rapidmx.io/dns-operation": "71a0ef7195df4865",
            });
            expect(await withOperations().reconcile(fixture())).toEqual({ result: "done" });
            expect(kube.writes().some((w) => w.startsWith("DELETE"))).toBe(false);
            expect(kube.objects.has(`${ENDPOINTS}/mail-op-71a0ef7195df4865`)).toBe(true);
        });
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

    it("tells its owner when a pass has ended, so the status report follows what was applied, but not when it may not write", async () => {
        vi.useFakeTimers();
        const onPass = vi.fn();
        const r = reconciler({ resyncMs: 600000, retryMs: 1000, now: Date.now, onPass });
        // Coalesced updates are one run of passes, so one call after it.
        r.update(fixture());
        r.update(fixture());
        expect(onPass).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(onPass).toHaveBeenCalledTimes(1);
        // The call comes after the objects were applied.
        expect(kube.writes()).toContain(`APPLY ${ENDPOINT}`);
        // A pass that ended incomplete is reported too: it applied some of it.
        credentials = { state: "unavailable", error: "HTTP 503" };
        kube.objects.clear();
        await vi.advanceTimersByTimeAsync(600000);
        expect(onPass).toHaveBeenCalledTimes(2);
        // A pass refused for lack of the Lease changed nothing: nothing to report.
        writable = false;
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(onPass).toHaveBeenCalledTimes(2);
        await r.stop();
        // Stopped: no call.
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(10000);
        expect(onPass).toHaveBeenCalledTimes(2);
    });

    it("tries again, with the pass's backoff, while the credentials can't be fetched", async () => {
        vi.useFakeTimers();
        credentials = { state: "unavailable", error: "HTTP 503" };
        const r = reconciler({ resyncMs: 600000, retryMs: 1000, now: Date.now });
        const passes = vi.spyOn(r, "reconcile");
        r.update(fixture());
        await vi.advanceTimersByTimeAsync(0);
        expect(passes).toHaveBeenCalledTimes(1);
        expect(fetched).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(passes).toHaveBeenCalledTimes(2);
        expect(fetched).toHaveLength(2);
        credentials = ok(credentialsFixture());
        await vi.advanceTimersByTimeAsync(2000);
        expect(kube.objects.get(SECRET).data).toEqual({ apiToken: b64(TOKEN) });
        await r.stop();
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
        expect(kube.writes()).toContain(`APPLY ${ENDPOINT}`);
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
        const r = reconciler({
            log: new Logger("debug", (l) => {
                if (l.includes("external_dns_image_refused")) {
                    throw new Error("the log is broken");
                }
            }),
        });
        await expect(r.reconcile(state)).rejects.toThrow("the log is broken");
    });

    it("stops writing at once and resolves its stop only when the request in flight has been answered", async () => {
        let answered: (() => void) | undefined;
        const apply = kube.client.apply;
        kube.client.apply = async <T>(path: string, body: KubeObject, options: ApplyOptions): Promise<T> => {
            if (path.includes("/deployments/")) {
                await new Promise<void>((resolve) => (answered = resolve));
            }
            return apply<T>(path, body, options);
        };
        const r = reconciler();
        const passes = vi.spyOn(r, "reconcile");
        r.update(fixture());
        await vi.waitFor(() => expect(answered).toBeDefined());
        let stopped = false;
        const stopping = r.stop().then(() => (stopped = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stopped).toBe(false);
        answered?.();
        await stopping;
        // Nothing after the answered request, and no credentials fetched for it: the Lease may be released now.
        expect(kube.writes()).toEqual([`APPLY ${DEPLOYMENT}`]);
        expect(fetched).toEqual([]);
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
