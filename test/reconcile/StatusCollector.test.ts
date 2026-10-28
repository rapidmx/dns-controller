import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1 } from "../../src/api/v1.js";
import { KubeError } from "../../src/kube/KubeClient.js";
import { Logger } from "../../src/log.js";
import type { ManifestSettings } from "../../src/reconcile/manifests.js";
import { OperationLedger } from "../../src/reconcile/OperationLedger.js";
import { StatusCollector, type StatusCollectorOptions } from "../../src/reconcile/StatusCollector.js";

const DEPLOYMENTS = "/apis/apps/v1/namespaces/rapidmx/deployments";
const PODS = "/api/v1/namespaces/rapidmx/pods";
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

const page = (name: string): string => readFileSync(new URL(`../fixtures/external-dns/v0.23.0/${name}`, import.meta.url), "utf8");

/** The labels of a provider's external-dns pod (the Deployment's pod template). */
const POD_LABELS = {
    "app.kubernetes.io/name": "external-dns",
    "app.kubernetes.io/instance": "mail",
    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
    "rapidmx.io/dns-provider": "cloudflare-main",
};

/** An external-dns pod as a list returns it. */
function pod(overrides: Record<string, unknown> = {}, name = "mail-external-dns-cloudflare-main-6d8f7-abcde", ip = "10.42.0.17"): Record<string, unknown> {
    return { metadata: { name, labels: POD_LABELS }, status: { phase: "Running", podIP: ip }, ...overrides };
}

function endpoint(generation: unknown, observedGeneration?: unknown, name = "mail-domain-example-com"): Record<string, unknown> {
    return { metadata: { name, generation }, spec: {}, ...(observedGeneration !== undefined ? { status: { observedGeneration } } : {}) };
}

describe("StatusCollector", () => {
    let lists: Record<string, unknown[] | Error>;
    let calls: string[];
    let lines: string[];
    let ledger: OperationLedger;
    /** What a pod's metrics URL answers with: a page, a response, or a failure; any other URL is refused. */
    let metrics: Record<string, string | Response | Error>;
    let scraped: [string, RequestInit][];

    const scrape = async (url: string, init: RequestInit): Promise<Response> => {
        scraped.push([url, init]);
        const answer = metrics[url];
        if (answer instanceof Error) {
            throw answer;
        }
        if (answer === undefined) {
            throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 10.42.0.17:7979"), { code: "ECONNREFUSED" }) });
        }
        return typeof answer === "string" ? new Response(answer, { status: 200 }) : answer;
    };

    function collector(extra: Partial<StatusCollectorOptions> = {}): StatusCollector {
        return new StatusCollector({
            fetch: scrape,
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
            ...extra,
        });
    }

    const logged = () => lines.map((l) => JSON.parse(l));

    beforeEach(() => {
        lists = { [DEPLOYMENTS]: [deployment()], [ENDPOINTS]: [endpoint(3, 3)] };
        calls = [];
        lines = [];
        ledger = new OperationLedger();
        metrics = {};
        scraped = [];
    });

    it("reports a provider's Deployment: its ready replicas, the image it runs and when it last rolled out", async () => {
        expect((await collector().collect(state())).providers).toEqual([
            { providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, lastRolloutAt: "2026-10-28T07:59:30.000Z" },
        ]);
    });

    it("lists the Deployments, the pods and the DNSEndpoints it manages once each, however many providers and endpoint sets there are", async () => {
        await collector().collect(state());
        expect(calls).toEqual([`${DEPLOYMENTS}?${SELECTOR}`, `${PODS}?${SELECTOR}`, `${ENDPOINTS}?${SELECTOR}`]);
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

    describe("the metrics of each provider's pod (D5)", () => {
        const URL_17 = "http://10.42.0.17:7979/metrics";
        const ROLLOUT = { lastRolloutAt: "2026-10-28T07:59:30.000Z" };
        const WHAT = "the metrics of pod mail-external-dns-cloudflare-main-6d8f7-abcde could not be read";

        beforeEach(() => {
            lists[PODS] = [pod()];
            metrics[URL_17] = page("metrics-synced.txt");
        });

        it("scrapes the provider's pod at its IP on external-dns's port and reports the last sync and the error counts", async () => {
            expect((await collector().collect(state())).providers).toEqual([
                {
                    providerUid: "cloudflare-main",
                    readyReplicas: 1,
                    image: IMAGE,
                    ...ROLLOUT,
                    lastSyncAt: "2026-10-28T01:48:48.607Z",
                    registryErrors: 0,
                    sourceErrors: 0,
                    providerErrors: 0,
                },
            ]);
            expect(scraped.map(([url]) => url)).toEqual([URL_17]);
        });

        it("asks for the text format with a timeout that covers the body", async () => {
            await collector().collect(state());
            const [, init] = scraped[0];
            expect((init.headers as Record<string, string>).Accept).toContain("text/plain");
            expect(init.signal).toBeInstanceOf(AbortSignal);
        });

        it("reports a failing provider by the counts and by the syncs it has failed in a row, with no sync time while it never synced", async () => {
            metrics[URL_17] = page("metrics-provider-failing.txt");
            expect((await collector().collect(state())).providers[0]).toEqual({
                providerUid: "cloudflare-main",
                readyReplicas: 1,
                image: IMAGE,
                ...ROLLOUT,
                registryErrors: 4,
                sourceErrors: 0,
                providerErrors: 4,
                lastError: "external-dns's syncs are failing (a provider error); see its log",
            });
        });

        it("words the error alike however many syncs have failed, so the server's row only changes when the state does", async () => {
            const errors: string[] = [];
            for (const failed of [1, 2, 7]) {
                metrics[URL_17] = `external_dns_build_info 1\nexternal_dns_controller_consecutive_soft_errors ${failed}\n`;
                errors.push((await collector().collect(state())).providers[0].lastError ?? "");
            }
            expect(errors).toEqual(Array(3).fill("external-dns's syncs are failing (a provider error); see its log"));
        });

        it("reports the records skipped for an owner mismatch when external-dns says there are some", async () => {
            metrics[URL_17] = `${page("metrics-synced.txt")}external_dns_registry_skipped_records_owner_mismatch_per_sync{domain="example.com",foreign_owner="x",owner="rapidmx",record_type="a"} 2\n`;
            const [entry] = (await collector().collect(state())).providers;
            expect(entry.ownerMismatchRecords).toBe(2);
            expect(entry).not.toHaveProperty("lastError");
        });

        it("brackets an IPv6 pod address", async () => {
            lists[PODS] = [pod({}, "v6", "fd00::17")];
            metrics["http://[fd00::17]:7979/metrics"] = page("metrics-synced.txt");
            expect((await collector().collect(state())).providers[0]).toHaveProperty("lastSyncAt");
        });

        it("scrapes each provider's own pods, and none of a provider the state no longer lists", async () => {
            const two = state();
            two.providers.push({ ...two.providers[0], uid: "route53-main", type: "route53" });
            lists[DEPLOYMENTS] = [deployment(), deployment({ metadata: { name: "mail-external-dns-route53-main", generation: 3 } })];
            lists[PODS] = [
                pod(),
                pod({ metadata: { name: "route53", labels: { ...POD_LABELS, "rapidmx.io/dns-provider": "route53-main" } } }, "route53", "10.42.0.18"),
                pod({ metadata: { name: "gone", labels: { ...POD_LABELS, "rapidmx.io/dns-provider": "deleted" } } }, "gone", "10.42.0.19"),
            ];
            metrics["http://10.42.0.18:7979/metrics"] = "external_dns_registry_errors_total 9\n";
            const { providers } = await collector().collect(two);
            expect(providers.map((p) => [p.providerUid, p.registryErrors])).toEqual([
                ["cloudflare-main", 0],
                ["route53-main", 9],
            ]);
            expect(scraped.map(([url]) => url).sort()).toEqual(["http://10.42.0.17:7979/metrics", "http://10.42.0.18:7979/metrics"]);
        });

        it("scrapes no pod that cannot answer or is not an instance's: not running, terminating, without a usable address, an operation's or unlabelled", async () => {
            lists[PODS] = [
                pod({ status: { phase: "Pending", podIP: "10.42.0.20" } }),
                pod({ status: { phase: "Running" } }),
                pod({ status: { phase: "Running", podIP: 7 } }),
                pod({ status: { phase: "Running", podIP: "10.42.0.21/evil" } }),
                pod({ status: { phase: "Running", podIP: "metrics.example.com" } }),
                pod({ metadata: { name: "going", deletionTimestamp: "2026-10-28T08:00:00Z", labels: POD_LABELS } }, "going", "10.42.0.22"),
                pod({ metadata: { name: "job", labels: { "app.kubernetes.io/name": "external-dns-operation", "rapidmx.io/dns-operation": "abc" } } }, "job", "10.42.0.23"),
                pod({ metadata: { name: "unlabelled" } }, "unlabelled", "10.42.0.24"),
                { status: { phase: "Running", podIP: "10.42.0.25" } },
            ];
            const [entry] = (await collector().collect(state())).providers;
            expect(scraped).toEqual([]);
            expect(entry).toEqual({ providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, ...ROLLOUT });
        });

        it("reports a provider without a pod with nothing of the metrics and no error: its ready replicas say it", async () => {
            lists[PODS] = [];
            expect((await collector().collect(state())).providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, ...ROLLOUT }]);
        });

        it("takes the pod that synced last when a rollout has two, and all its numbers from that one", async () => {
            lists[PODS] = [pod({}, "new"), pod({}, "old", "10.42.0.30"), pod({}, "never", "10.42.0.31")];
            metrics[URL_17] = "external_dns_controller_last_sync_timestamp_seconds 1.7931522e+09\nexternal_dns_registry_errors_total 1\n";
            metrics["http://10.42.0.30:7979/metrics"] = "external_dns_controller_last_sync_timestamp_seconds 1.7931524e+09\nexternal_dns_registry_errors_total 2\n";
            metrics["http://10.42.0.31:7979/metrics"] = "external_dns_controller_last_sync_timestamp_seconds 0\nexternal_dns_registry_errors_total 3\n";
            expect((await collector().collect(state())).providers[0]).toMatchObject({ lastSyncAt: "2026-10-28T01:53:20.000Z", registryErrors: 2 });
        });

        it("takes the first pod when none has synced or they synced at the same time", async () => {
            lists[PODS] = [pod({}, "a"), pod({}, "b", "10.42.0.30")];
            metrics[URL_17] = "external_dns_registry_errors_total 1\n";
            metrics["http://10.42.0.30:7979/metrics"] = "external_dns_registry_errors_total 2\n";
            expect((await collector().collect(state())).providers[0].registryErrors).toBe(1);
            metrics[URL_17] = "external_dns_controller_last_sync_timestamp_seconds 1.7931522e+09\nexternal_dns_registry_errors_total 1\n";
            metrics["http://10.42.0.30:7979/metrics"] = "external_dns_controller_last_sync_timestamp_seconds 1.7931522e+09\nexternal_dns_registry_errors_total 2\n";
            expect((await collector().collect(state())).providers[0].registryErrors).toBe(1);
            // One that synced beats one that never did, in either order.
            metrics[URL_17] = "external_dns_registry_errors_total 1\n";
            expect((await collector().collect(state())).providers[0].registryErrors).toBe(2);
        });

        it("ignores a pod it could not read while another answered", async () => {
            lists[PODS] = [pod({}, "old", "10.42.0.30"), pod({}, "new")];
            delete metrics["http://10.42.0.30:7979/metrics"];
            const [entry] = (await collector().collect(state())).providers;
            expect(entry).toHaveProperty("lastSyncAt");
            expect(entry).not.toHaveProperty("lastError");
        });

        it("reports the connection error when the pod can't be reached, and nothing it could not read", async () => {
            delete metrics[URL_17];
            const [entry] = (await collector().collect(state())).providers;
            expect(entry).toEqual({ providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, ...ROLLOUT, lastError: `${WHAT}: ECONNREFUSED` });
            expect(logged().filter((e) => e.msg === "metrics_scrape_failed")).toMatchObject([
                { level: "warn", providerUid: "cloudflare-main", pod: "mail-external-dns-cloudflare-main-6d8f7-abcde", reason: "ECONNREFUSED" },
            ]);
        });

        it.each([
            ["an error status", new Response("nope", { status: 500 }), "HTTP 500"],
            ["a page that is not external-dns's", new Response('{"status":"ok"}', { status: 200 }), "not an external-dns metrics page"],
            ["a failure with a code of its own", Object.assign(new Error("read failed"), { code: "ECONNRESET" }), "ECONNRESET"],
            ["a failure without a code", new Error("socket hang up"), "socket hang up"],
        ])("reports %s as the reason the metrics could not be read", async (_what, answer, reason) => {
            metrics[URL_17] = answer;
            expect((await collector().collect(state())).providers[0].lastError).toBe(`${WHAT}: ${reason}`);
        });

        it("refuses a page over the size limit without reading the rest of it", async () => {
            let pulled = 0;
            const endless = new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulled++;
                    controller.enqueue(new Uint8Array(1024).fill(97));
                },
            });
            metrics[URL_17] = new Response(endless);
            const [entry] = (await collector({ metricsMaxBytes: 4096 }).collect(state())).providers;
            expect(entry.lastError).toBe(`${WHAT}: page too large`);
            expect(pulled).toBeLessThan(10);
        });

        it("reads a page that is exactly the size limit, and one that arrives in pieces", async () => {
            const text = page("metrics-synced.txt");
            const bytes = new TextEncoder().encode(text);
            const pieces = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes.subarray(0, 7));
                    controller.enqueue(bytes.subarray(7));
                    controller.close();
                },
            });
            metrics[URL_17] = new Response(pieces);
            const [entry] = (await collector({ metricsMaxBytes: bytes.byteLength }).collect(state())).providers;
            expect(entry.lastError).toBeUndefined();
            expect(entry.registryErrors).toBeDefined();
        });

        it("reads a response without a body as an empty page", async () => {
            metrics[URL_17] = new Response(null, { status: 200 });
            expect((await collector().collect(state())).providers[0].lastError).toBe(`${WHAT}: not an external-dns metrics page`);
        });

        it("reports a failure that is no Error object by its text", async () => {
            const refusing = (async () => Promise.reject("refused")) as unknown as typeof fetch;
            expect((await collector({ fetch: refusing }).collect(state())).providers[0].lastError).toBe(`${WHAT}: refused`);
        });

        it("gives up on a pod that doesn't answer within the timeout", async () => {
            const hanging = (async (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
            const [entry] = (await collector({ fetch: hanging, metricsTimeoutMs: 20 }).collect(state())).providers;
            expect(entry.lastError).toBe(`${WHAT}: timed out`);
        });

        it("scrapes the pods side by side, so one that hangs delays the report by the timeout once", async () => {
            lists[PODS] = [pod({}, "a"), pod({}, "b", "10.42.0.30")];
            const started: string[] = [];
            const slow = (async (url: string, init: RequestInit) => {
                started.push(url);
                return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
            }) as unknown as typeof fetch;
            const pending = collector({ fetch: slow, metricsTimeoutMs: 50 }).collect(state());
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(started).toHaveLength(2);
            await pending;
        });

        it("still reports the Deployments' entries when the pods can't be listed, saying why in the log", async () => {
            lists[PODS] = new KubeError("GET /api/v1/namespaces/rapidmx/pods: HTTP 403", 403, "Forbidden");
            const entries = await collector().collect(state());
            expect(entries.providers).toEqual([{ providerUid: "cloudflare-main", readyReplicas: 1, image: IMAGE, ...ROLLOUT }]);
            expect(entries.endpoints).toHaveLength(1);
            expect(logged().filter((e) => e.msg === "status_entries_failed")).toMatchObject([{ level: "warn", kind: "Pod", error: { name: "KubeError" } }]);
        });

        it("leaves the pods alone when the Deployments can't be listed: there are no entries to add to", async () => {
            lists[DEPLOYMENTS] = new Error("down");
            expect((await collector().collect(state())).providers).toEqual([]);
            expect(calls.filter((c) => c.startsWith(PODS))).toEqual([]);
        });

        it("lists no pods for a state without providers", async () => {
            const none = state();
            none.providers = [];
            expect((await collector().collect(none)).providers).toEqual([]);
            expect(calls.filter((c) => c.startsWith(PODS))).toEqual([]);
        });

        it("scrapes with the global fetch when it isn't given one", async () => {
            const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(page("metrics-synced.txt")));
            try {
                const get = async <T>(path: string): Promise<T> => ({ items: lists[path.split("?")[0]] ?? [] }) as T;
                const alone = new StatusCollector({ kube: { get }, settings, log: new Logger("debug", () => undefined) });
                expect((await alone.collect(state())).providers[0]).toHaveProperty("lastSyncAt");
                expect(spy).toHaveBeenCalledWith(URL_17, expect.anything());
            } finally {
                spy.mockRestore();
            }
        });
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
