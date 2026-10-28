import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1 } from "../../src/api/v1.js";
import { KubeError } from "../../src/kube/KubeClient.js";
import { Logger } from "../../src/log.js";
import type { ManifestSettings } from "../../src/reconcile/manifests.js";
import { OperationLedger } from "../../src/reconcile/OperationLedger.js";
import { StatusCollector } from "../../src/reconcile/StatusCollector.js";

const DEPLOYMENTS = "/apis/apps/v1/namespaces/rapidmx/deployments";
const ENDPOINTS = "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints";
const SELECTOR = "labelSelector=app.kubernetes.io%2Fmanaged-by%3Drapidmx-dns-controller%2Capp.kubernetes.io%2Finstance%3Dmail";
const IMAGE = "registry.k8s.io/external-dns/external-dns:v0.23.0";

const settings: ManifestSettings = {
    namespace: "rapidmx",
    fullname: "mail",
    release: "mail",
    externalDnsImage: IMAGE,
    externalDnsServiceAccount: "mail-external-dns",
};

const state = (): DesiredStateV1 => parseDesiredState(JSON.parse(readFileSync(new URL("../fixtures/api/v1/desired-state.json", import.meta.url), "utf8")));

/** What the list of Deployments returns for the fixture's provider once its instance is running. */
function deployment(overrides: Record<string, unknown> = {}, status: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        metadata: { name: "mail-external-dns-cloudflare-main", generation: 3 },
        spec: { template: { spec: { containers: [{ name: "external-dns", image: IMAGE }] } } },
        status: {
            observedGeneration: 3,
            replicas: 1,
            readyReplicas: 1,
            conditions: [
                { type: "Available", status: "True", lastTransitionTime: "2026-10-28T08:00:00Z", lastUpdateTime: "2026-10-28T08:00:00Z" },
                { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable", lastTransitionTime: "2026-10-27T10:00:00Z", lastUpdateTime: "2026-10-28T07:59:30Z" },
            ],
            ...status,
        },
        ...overrides,
    };
}

function endpoint(generation: unknown, observedGeneration?: unknown, name = "mail-domain-example-com"): Record<string, unknown> {
    return { metadata: { name, generation }, spec: {}, ...(observedGeneration !== undefined ? { status: { observedGeneration } } : {}) };
}

describe("StatusCollector", () => {
    let lists: Record<string, unknown[] | Error>;
    let calls: string[];
    let lines: string[];
    let ledger: OperationLedger;

    function collector(): StatusCollector {
        return new StatusCollector({
            kube: {
                get: async <T>(path: string): Promise<T> => {
                    calls.push(path);
                    const answer = lists[path.split("?")[0]];
                    if (answer instanceof Error) {
                        throw answer;
                    }
                    // The API server may leave `items` out of an empty list.
                    return (answer && answer.length > 0 ? { items: answer } : {}) as T;
                },
            },
            settings,
            log: new Logger("debug", (l) => lines.push(l)),
            ledger,
        });
    }

    const logged = () => lines.map((l) => JSON.parse(l));

    beforeEach(() => {
        lists = { [DEPLOYMENTS]: [deployment()], [ENDPOINTS]: [endpoint(3, 3)] };
        calls = [];
        lines = [];
        ledger = new OperationLedger();
    });

    it("reports a provider's Deployment: its ready replicas, the image it runs and when it last rolled out", async () => {
        expect((await collector().collect(state())).providers).toEqual([
            { providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, lastRolloutAt: "2026-10-28T07:59:30.000Z" },
        ]);
    });

    it("lists the Deployments and the DNSEndpoints it manages once each, however many providers and endpoint sets there are", async () => {
        await collector().collect(state());
        expect(calls).toEqual([`${DEPLOYMENTS}?${SELECTOR}`, `${ENDPOINTS}?${SELECTOR}`]);
    });

    it("reports a provider whose Deployment isn't there with no ready replicas and nothing else", async () => {
        lists[DEPLOYMENTS] = [];
        expect((await collector().collect(state())).providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 0 }]);
    });

    it("ignores the Deployments of other providers, such as one the state no longer has", async () => {
        lists[DEPLOYMENTS] = [deployment({ metadata: { name: "mail-external-dns-gone", generation: 1 } }), deployment()];
        expect((await collector().collect(state())).providers.map((p) => [p.providerUid, p.readyReplicas])).toEqual([["cloudflare-main", 1]]);
    });

    it("reports no ready replicas for a Deployment status that is older than its spec", async () => {
        lists[DEPLOYMENTS] = [deployment({}, { observedGeneration: 2 })];
        const [entry] = (await collector().collect(state())).providers;
        expect(entry).toMatchObject({ providerUid: "cloudflare-main", readyReplicas: 0, image: IMAGE });
    });

    it("reports no ready replicas for a Deployment whose status isn't there yet", async () => {
        lists[DEPLOYMENTS] = [{ metadata: { name: "mail-external-dns-cloudflare-main", generation: 1 }, spec: {} }];
        expect((await collector().collect(state())).providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 0 }]);
    });

    it("reports a disabled provider's instance, which runs no replica", async () => {
        const disabled = state();
        disabled.providers[0].enabled = false;
        lists[DEPLOYMENTS] = [deployment({}, { replicas: 0, readyReplicas: undefined })];
        expect((await collector().collect(disabled)).providers[0]).toMatchObject({ providerUid: "cloudflare-main", readyReplicas: 0, image: IMAGE });
    });

    it.each([
        ["a negative count", -1],
        ["a fraction", 0.5],
        ["text", "1"],
    ])("counts %s of ready replicas as none", async (_what, value) => {
        lists[DEPLOYMENTS] = [deployment({}, { readyReplicas: value })];
        expect((await collector().collect(state())).providers[0].readyReplicas).toBe(0);
    });

    it("leaves out an image and a rollout time the Deployment doesn't say or says wrongly", async () => {
        const odd: [Record<string, unknown>, Record<string, unknown>][] = [
            [{ spec: { template: { spec: { containers: [{ name: "sidecar", image: "other" }] } } } }, { conditions: [] }],
            [{ spec: { template: { spec: { containers: [{ name: "external-dns" }] } } } }, { conditions: [{ type: "Progressing", status: "True", reason: "NewReplicaSetAvailable", lastUpdateTime: "yesterday" }] }],
            [{ spec: { template: { spec: { containers: [{ name: "external-dns", image: 7 }] } } } }, { conditions: [{ type: "Available", lastUpdateTime: "2026-10-28T08:00:00Z" }] }],
            [{ spec: { template: {} } }, { conditions: [{ type: "Progressing" }] }],
            [{ spec: {} }, { conditions: undefined }],
        ];
        for (const [overrides, status] of odd) {
            lists[DEPLOYMENTS] = [deployment(overrides, status)];
            expect((await collector().collect(state())).providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 1 }]);
        }
    });

    it.each([
        ["a rollout under way", "True", "ReplicaSetUpdated"],
        ["a rollout that failed", "False", "ProgressDeadlineExceeded"],
        ["a Deployment scaled up again", "True", "NewReplicaSetCreated"],
        ["a condition that is not True", "False", "NewReplicaSetAvailable"],
    ])("reports no rollout time while the Progressing condition says %s: the Deployment controller moves its time on then too", async (_what, status, reason) => {
        lists[DEPLOYMENTS] = [
            deployment({}, { conditions: [{ type: "Progressing", status, reason, lastUpdateTime: "2026-10-28T08:10:00Z" }] }),
        ];
        expect((await collector().collect(state())).providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE }]);
    });

    it("reports a DNSEndpoint's generation and what external-dns has observed of it", async () => {
        lists[ENDPOINTS] = [endpoint(4, 3)];
        expect((await collector().collect(state())).endpoints).toEqual([{ endpointSetId: "domain-example-com", generation: 4, observedGeneration: 3 }]);
    });

    it("reports an endpoint external-dns hasn't read yet with its generation alone", async () => {
        lists[ENDPOINTS] = [endpoint(1)];
        expect((await collector().collect(state())).endpoints).toEqual([{ endpointSetId: "domain-example-com", generation: 1 }]);
    });

    it("leaves out an observed generation that isn't a whole number", async () => {
        lists[ENDPOINTS] = [endpoint(2, "2")];
        expect((await collector().collect(state())).endpoints).toEqual([{ endpointSetId: "domain-example-com", generation: 2 }]);
    });

    it("reports no endpoint that isn't there, has no generation, or belongs to no endpoint set of the state", async () => {
        lists[ENDPOINTS] = [endpoint(undefined, 1), endpoint(2, 2, "mail-domain-gone-com")];
        expect((await collector().collect(state())).endpoints).toEqual([]);
        lists[ENDPOINTS] = [];
        expect((await collector().collect(state())).endpoints).toEqual([]);
    });

    it("reports the hosts' endpoint set too, by the id the state gave it", async () => {
        const withHosts = state();
        withHosts.endpointSets.push({ id: "hosts-cloudflare-main", providerUid: "cloudflare-main", records: [] });
        lists[ENDPOINTS] = [endpoint(1, 1), endpoint(5, 4, "mail-hosts-cloudflare-main")];
        expect((await collector().collect(withHosts)).endpoints).toEqual([
            { endpointSetId: "domain-example-com", generation: 1, observedGeneration: 1 },
            { endpointSetId: "hosts-cloudflare-main", generation: 5, observedGeneration: 4 },
        ]);
    });

    it("reports the result of each operation the state lists that the controller has one for", async () => {
        const queued = state();
        queued.operations = [
            { id: "op-1", type: "test", providerUid: "cloudflare-main" },
            { id: "op-2", type: "takeover", providerUid: "cloudflare-main" },
            { id: "op-3", type: "restore", providerUid: "cloudflare-main" },
        ];
        ledger.record("op-1", "running");
        ledger.record("op-2", "failed", "the record is owned by another deployment");
        expect((await collector().collect(queued)).operations).toEqual([
            { id: "op-1", state: "running" },
            { id: "op-2", state: "failed", message: "the record is owned by another deployment" },
        ]);
    });

    it("reports no result of an operation the state doesn't list, and leaves the ledger alone: a report for an older state must not drop a result recorded for a newer one", async () => {
        const older = state();
        older.operations = [{ id: "op-1", type: "test", providerUid: "cloudflare-main" }];
        ledger.record("op-1", "succeeded", "ok");
        ledger.record("op-2", "succeeded", "listed only by the newer state");
        expect((await collector().collect(older)).operations).toEqual([{ id: "op-1", state: "succeeded", message: "ok" }]);
        expect(ledger.get("op-2")).toEqual({ state: "succeeded", message: "listed only by the newer state" });
    });

    it("reports an operation anew until the server stops listing it, and a later result replaces an earlier", async () => {
        const queued = state();
        queued.operations = [{ id: "op-1", type: "test", providerUid: "cloudflare-main" }];
        ledger.record("op-1", "running");
        expect((await collector().collect(queued)).operations).toEqual([{ id: "op-1", state: "running" }]);
        ledger.record("op-1", "succeeded");
        expect((await collector().collect(queued)).operations).toEqual([{ id: "op-1", state: "succeeded" }]);
        expect((await collector().collect(queued)).operations).toEqual([{ id: "op-1", state: "succeeded" }]);
    });

    it("still reports the endpoints and the operations when the Deployments can't be listed, saying why in the log", async () => {
        lists[DEPLOYMENTS] = new KubeError("GET /apis/apps/v1/namespaces/rapidmx/deployments: HTTP 403", 403, "Forbidden");
        const entries = await collector().collect(state());
        expect(entries.providers).toEqual([]);
        expect(entries.endpoints).toHaveLength(1);
        expect(logged().filter((e) => e.msg === "status_entries_failed")).toMatchObject([
            { level: "warn", kind: "Deployment", error: { name: "KubeError", message: expect.stringContaining("HTTP 403") } },
        ]);
    });

    it("still reports the providers when the DNSEndpoints can't be listed, such as before the CRD is installed", async () => {
        lists[ENDPOINTS] = new KubeError("GET /apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints: HTTP 404", 404, "NotFound");
        const entries = await collector().collect(state());
        expect(entries.endpoints).toEqual([]);
        expect(entries.providers).toHaveLength(1);
        expect(logged().filter((e) => e.msg === "status_entries_failed")).toMatchObject([{ level: "warn", kind: "DNSEndpoint" }]);
    });

    it("reports nothing it could not read as if it had", async () => {
        lists[DEPLOYMENTS] = new Error("down");
        lists[ENDPOINTS] = new Error("down");
        expect(await collector().collect(state())).toEqual({ providers: [], endpoints: [], operations: [] });
        expect(logged().filter((e) => e.msg === "status_entries_failed")).toHaveLength(2);
    });

    it("keeps a ledger of its own when it isn't given one", async () => {
        const queued = state();
        queued.operations = [{ id: "op-1", type: "test", providerUid: "cloudflare-main" }];
        const alone = new StatusCollector({ kube: { get: async <T>() => ({}) as T }, settings, log: new Logger("debug", () => undefined) });
        expect((await alone.collect(queued)).operations).toEqual([]);
    });
});
