import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1, type OperationV1 } from "../../src/api/v1.js";
import { KubeError } from "../../src/kube/KubeClient.js";
import { Logger } from "../../src/log.js";
import { operationEndpoint, operationJob, type ManifestSettings } from "../../src/reconcile/manifests.js";
import { NotWriterError } from "../../src/reconcile/NotWriterError.js";
import { OperationLedger } from "../../src/reconcile/OperationLedger.js";
import { OperationRunner } from "../../src/reconcile/OperationRunner.js";

const JOBS = "/apis/batch/v1/namespaces/rapidmx/jobs";
const PODS = "/api/v1/namespaces/rapidmx/pods";
const ENDPOINTS = "/apis/externaldns.k8s.io/v1alpha1/namespaces/rapidmx/dnsendpoints";
const DEPLOYMENT = "/apis/apps/v1/namespaces/rapidmx/deployments/mail-external-dns-cloudflare-main";
const SECRET = "/api/v1/namespaces/rapidmx/secrets/mail-dns-cloudflare-main";
const REGULAR = `${ENDPOINTS}/mail-domain-example-com`;
const NAME = "mail-op-71a0ef7195df4865";
const JOB = `${JOBS}/${NAME}`;
const TEMPORARY = `${ENDPOINTS}/${NAME}`;
const PIN = "registry.k8s.io/external-dns/external-dns:v0.23.0";

const settings: ManifestSettings = {
    namespace: "rapidmx",
    fullname: "mail",
    release: "mail",
    externalDnsImage: PIN,
    externalDnsServiceAccount: "mail-external-dns",
};

type KubeObject = { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> }; [key: string]: unknown };

/** An in-memory namespace: label-selected lists, single reads, apply, create and delete, with failures on demand. */
class FakeKube {
    objects = new Map<string, KubeObject>();
    calls: string[] = [];
    failures = new Map<string, Error>();

    private fail(call: string): void {
        this.calls.push(call);
        for (const [prefix, error] of this.failures) {
            if (call.startsWith(prefix)) {
                throw error;
            }
        }
    }

    put(path: string, object: Omit<KubeObject, "metadata"> & { metadata?: Partial<KubeObject["metadata"]> }): void {
        const name = path.slice(path.lastIndexOf("/") + 1);
        this.objects.set(path, { ...object, metadata: { name, ...object.metadata } });
    }

    readonly client = {
        get: async <T>(path: string): Promise<T> => {
            this.fail(`GET ${path}`);
            const [collection, query] = path.split("?");
            if (query === undefined) {
                const object = this.objects.get(collection);
                if (!object) {
                    throw new KubeError("not found", 404, "NotFound");
                }
                return structuredClone(object) as T;
            }
            const wanted = Object.fromEntries(
                (new URLSearchParams(query).get("labelSelector") ?? "")
                    .split(",")
                    .map((pair) => pair.split("="))
            );
            const items = [...this.objects.entries()]
                .filter(([key, object]) => key.startsWith(`${collection}/`) && Object.entries(wanted).every(([k, v]) => object.metadata.labels?.[k] === v))
                .map(([, object]) => structuredClone(object));
            // The API server may leave `items` out of an empty list.
            return (items.length > 0 ? { items } : {}) as T;
        },
        getMetadata: async <T>(path: string): Promise<T> => {
            this.fail(`META ${path}`);
            const object = this.objects.get(path);
            if (!object) {
                throw new KubeError("not found", 404, "NotFound");
            }
            return { metadata: structuredClone(object.metadata) } as T;
        },
        apply: async <T>(path: string, body: KubeObject): Promise<T> => {
            this.fail(`APPLY ${path}`);
            this.objects.set(path, structuredClone(body));
            return structuredClone(body) as T;
        },
        create: async <T>(path: string, body: KubeObject): Promise<T> => {
            this.fail(`CREATE ${path}`);
            const key = `${path}/${body.metadata.name}`;
            if (this.objects.has(key)) {
                throw new KubeError("already exists", 409, "AlreadyExists");
            }
            this.objects.set(key, structuredClone(body));
            return structuredClone(body) as T;
        },
        delete: async <T>(path: string): Promise<T> => {
            this.fail(`DELETE ${path}`);
            if (!this.objects.delete(path.split("?")[0])) {
                throw new KubeError("not found", 404, "NotFound");
            }
            return {} as T;
        },
    };

    writes(): string[] {
        return this.calls.filter((c) => c.startsWith("APPLY") || c.startsWith("CREATE") || c.startsWith("DELETE"));
    }
}

const fixtureText = readFileSync(new URL("../fixtures/api/v1/desired-state.json", import.meta.url), "utf8");

const ours = { "app.kubernetes.io/managed-by": "rapidmx-dns-controller", "rapidmx.io/secret-kind": "dns", "rapidmx.io/dns-provider": "cloudflare-main" };
const jobLabels = { "app.kubernetes.io/managed-by": "rapidmx-dns-controller", "app.kubernetes.io/instance": "mail" };

const TEST: OperationV1 = { id: "op-1", type: "test", providerUid: "cloudflare-main" };
const TAKEOVER: OperationV1 = {
    id: "op-1",
    type: "takeover",
    providerUid: "cloudflare-main",
    endpointSetId: "domain-example-com",
    records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }],
};
const RESTORE: OperationV1 = {
    id: "op-1",
    type: "restore",
    providerUid: "cloudflare-main",
    endpointSetId: "domain-example-com",
    records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "keep me"], ttl: 300 }],
};

describe("OperationRunner", () => {
    let kube: FakeKube;
    let lines: string[];
    let ledger: OperationLedger;
    let writable: boolean;
    let clock: number;
    let state: DesiredStateV1;
    let latest: DesiredStateV1 | undefined;

    function runner(extra: Partial<ConstructorParameters<typeof OperationRunner>[0]> = {}): OperationRunner {
        return new OperationRunner({
            kube: kube.client,
            settings,
            log: new Logger("debug", (l) => lines.push(l)),
            ledger,
            latest: () => latest,
            now: () => clock,
            ...extra,
        });
    }

    const run = (r: OperationRunner, s: DesiredStateV1 = state) => r.run(s, () => writable);
    const logged = (msg: string): Record<string, unknown>[] => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);
    const result = (id = "op-1") => ledger.get(id);

    /** Queues `operation` in the state the runner is given (and is the latest one). */
    function queue(...operations: OperationV1[]): void {
        state.operations = operations;
    }

    /** The provider's Secret, as the reconciler writes it, at the generation the state lists. */
    const secretReady = (generation = "1", labels: Record<string, string> = ours): void => {
        kube.put(SECRET, { metadata: { labels, annotations: { "rapidmx.io/credentials-generation": generation } } });
    };

    /** The domain's regular DNSEndpoint, holding `names` as MX and TXT records. */
    const regularEndpoint = (...entries: { dnsName: string; recordType: string }[]): void => {
        kube.put(REGULAR, { spec: { endpoints: entries.map((e) => ({ ...e, targets: ["x"] })) } });
    };

    const instance = (status: Record<string, unknown>, generation = 1): void => {
        kube.put(DEPLOYMENT, { metadata: { generation } as never, status });
    };

    /** The state of the Job once Kubernetes has finished with it. */
    const finish = (conditions: Record<string, unknown>[]): void => {
        kube.objects.get(JOB).status = { conditions };
    };
    const complete = (): void => finish([{ type: "Complete", status: "True" }]);

    beforeEach(() => {
        kube = new FakeKube();
        lines = [];
        ledger = new OperationLedger();
        writable = true;
        clock = Date.parse("2026-10-28T10:00:00Z");
        state = parseDesiredState(JSON.parse(fixtureText));
        latest = state;
        secretReady();
    });

    describe("a credentials test", () => {
        it("runs the dry-run Job from the pinned image and reports it running, with no endpoint written", async () => {
            queue(TEST);
            const outcome = await run(runner());
            expect(outcome).toEqual({ pending: true });
            expect(kube.writes()).toEqual([`CREATE ${JOBS}`]);
            expect(kube.objects.get(JOB)).toEqual(operationJob(TEST, state.providers[0], settings, []));
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("dry run") });
            expect(logged("operation_started")).toEqual([expect.objectContaining({ operationId: "op-1", type: "test", providerUid: "cloudflare-main", job: NAME })]);
        });

        it("keeps reporting it running, writing nothing more, while the Job is active", async () => {
            queue(TEST);
            await run(runner());
            kube.calls = [];
            expect(await run(runner())).toEqual({ pending: true });
            expect(kube.writes()).toEqual([]);
            expect(result()).toMatchObject({ state: "running" });
        });

        it("reports success once the Job completed, and keeps the Job so a restart can read the result again", async () => {
            queue(TEST);
            await run(runner());
            complete();
            kube.calls = [];
            expect(await run(runner())).toEqual({ pending: false });
            expect(result()).toEqual({ state: "succeeded", message: expect.stringContaining("credentials work") });
            expect(kube.objects.has(JOB)).toBe(true);
            expect(kube.writes()).toEqual([]);
            expect(logged("operation_finished")).toEqual([expect.objectContaining({ operationId: "op-1", state: "succeeded" })]);
        });

        it("does not look at a finished operation again", async () => {
            queue(TEST);
            ledger.record("op-1", "succeeded", "done");
            kube.calls = [];
            expect(await run(runner())).toEqual({ pending: false });
            // Only the two lists of the sweep.
            expect(kube.calls.every((c) => c.includes("?labelSelector"))).toBe(true);
            expect(result()).toEqual({ state: "succeeded", message: "done" });
        });

        it("reports the last error external-dns logged when its Job failed", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" }]);
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: {
                    containerStatuses: [
                        {
                            name: "external-dns",
                            state: {
                                terminated: {
                                    exitCode: 1,
                                    message: [
                                        '{"level":"info","msg":"Instantiating new Kubernetes client","time":"2026-10-28T10:00:00Z"}',
                                        '{"level":"fatal","msg":"Cloudflare API error: Authentication error (10000)","time":"2026-10-28T10:00:01Z"}',
                                        "",
                                    ].join("\n"),
                                },
                            },
                        },
                    ],
                },
            });
            expect(await run(runner())).toEqual({ pending: false });
            expect(result()).toEqual({ state: "failed", message: "external-dns failed: Cloudflare API error: Authentication error (10000)" });
            expect(kube.calls).toContain(`GET ${PODS}?labelSelector=job-name%3D${NAME}`);
            expect(logged("operation_finished")).toEqual([expect.objectContaining({ state: "failed" })]);
        });

        it("cuts the error external-dns logged to 500 characters", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", message: "x" }]);
            const terminated = (message: string) => ({ containerStatuses: [{ name: "external-dns", state: { terminated: { message } } }] });
            kube.put(`${PODS}/${NAME}-x`, { metadata: { labels: { "job-name": NAME } }, status: terminated(`{"level":"error","msg":"${"y".repeat(600)}"}\n`) });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: `external-dns failed: ${"y".repeat(500)}` });
        });

        it("reports how the container ended, not a log line, when the log holds no error (an OOM-killed or killed process)", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit" }]);
            const logTail = '{"level":"info","msg":"Applying provider record filter for domains: [example.com.]","time":"2026-10-28T10:00:00Z"}\npanic: out of memory';
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: { containerStatuses: [{ name: "external-dns", state: { terminated: { reason: "OOMKilled", exitCode: 137, message: logTail } } }] },
            });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "external-dns failed: OOMKilled (exit code 137)" });
            // A reason without an exit code is the reason alone.
            ledger.clear();
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: { containerStatuses: [{ name: "external-dns", state: { terminated: { reason: "Error", message: logTail } } }] },
            });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "external-dns failed: Error" });
        });

        it("ignores a log line that is JSON but not an error, and one that is JSON null, going on to the Job's own reason", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", message: "x" }]);
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: { containerStatuses: [{ name: "external-dns", state: { terminated: { message: 'null\n{"level":"info","msg":"listing zones"}\n42' } } }] },
            });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The Job failed: x" });
        });

        it("reports why the pod never started when it has no log", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "Job was active longer than specified deadline" }]);
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: {
                    containerStatuses: [
                        { name: "other", state: { terminated: { message: "not external-dns" } } },
                        { name: "external-dns", state: { waiting: { reason: "CreateContainerConfigError", message: 'secret "mail-dns-cloudflare-main" not found' } } },
                    ],
                },
            });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: 'external-dns failed: CreateContainerConfigError: secret "mail-dns-cloudflare-main" not found' });
            // A reason without a message is the reason alone.
            ledger.clear();
            kube.put(`${PODS}/${NAME}-x`, {
                metadata: { labels: { "job-name": NAME } },
                status: { containerStatuses: [{ name: "external-dns", state: { waiting: { reason: "ImagePullBackOff" } } }] },
            });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "external-dns failed: ImagePullBackOff" });
        });

        it("reports the reason Kubernetes gave when the pod says nothing, and when its pods can't be read", async () => {
            queue(TEST);
            await run(runner());
            finish([{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "Job was active longer than specified deadline" }]);
            // No pod at all, then a waiting pod without a reason, then pods that can't be listed.
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The Job failed: DeadlineExceeded: Job was active longer than specified deadline" });
            // The Job's reason is cut like the pod's.
            finish([{ type: "Failed", status: "True", reason: "Odd", message: "z".repeat(600) }]);
            ledger.clear();
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: `The Job failed: ${`Odd: ${"z".repeat(600)}`.slice(0, 500)}` });
            finish([{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "Job was active longer than specified deadline" }]);
            ledger.clear();
            kube.put(`${PODS}/${NAME}-x`, { metadata: { labels: { "job-name": NAME } }, status: { containerStatuses: [{ name: "external-dns", state: { waiting: {} } }, { name: "external-dns" }] } });
            await run(runner());
            expect(result()).toMatchObject({ state: "failed", message: expect.stringContaining("The Job failed") });
            ledger.clear();
            // A log of nothing but blank lines says nothing either.
            kube.put(`${PODS}/${NAME}-z`, {
                metadata: { labels: { "job-name": NAME } },
                status: { containerStatuses: [{ name: "external-dns", state: { terminated: { message: " \n\n" } } }] },
            });
            ledger.clear();
            await run(runner());
            expect(result()).toMatchObject({ state: "failed", message: expect.stringContaining("The Job failed") });
            ledger.clear();
            kube.put(`${PODS}/${NAME}-y`, { metadata: { labels: { "job-name": NAME } } });
            kube.failures.set(`GET ${PODS}`, new KubeError("forbidden", 403, "Forbidden"));
            await run(runner());
            expect(result()).toMatchObject({ state: "failed", message: expect.stringContaining("The Job failed") });
            expect(logged("operation_pods_unreadable")).toHaveLength(1);
            finish([{ type: "Failed", status: "True" }]);
            ledger.clear();
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The Job failed: no reason given" });
        });

        it("waits for the provider's credentials Secret before running, saying so", async () => {
            queue(TEST);
            // Not there yet, not this controller's, and at another generation.
            kube.objects.delete(SECRET);
            expect(await run(runner())).toEqual({ pending: true });
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("credentials") });
            secretReady("1", { ...ours, "rapidmx.io/secret-kind": "other" });
            await run(runner());
            secretReady("0");
            await run(runner());
            kube.put(SECRET, { metadata: { labels: ours } });
            await run(runner());
            expect(kube.writes()).toEqual([]);
            secretReady();
            await run(runner());
            expect(kube.writes()).toEqual([`CREATE ${JOBS}`]);
        });

        it("needs no Secret for a config without credentials (Route 53 through IRSA)", async () => {
            kube.objects.delete(SECRET);
            delete state.providers[0].credentials;
            state.providers[0].type = "route53";
            queue(TEST);
            await run(runner());
            expect(kube.writes()).toEqual([`CREATE ${JOBS}`]);
            expect(kube.calls.some((c) => c.startsWith("META"))).toBe(false);
        });

        it("fails an operation whose provider config is gone or can't run, naming why", async () => {
            queue({ ...TEST, providerUid: "gone" });
            expect(await run(runner())).toEqual({ pending: false });
            expect(result()).toEqual({ state: "failed", message: "The provider config isn't in the desired state." });
            ledger.clear();
            queue(TEST);
            state.providers[0].credentials = { keys: [], generation: 1 };
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The provider config can't run: missing credentials: apiToken." });
            expect(kube.writes()).toEqual([]);
        });

        it("tests a disabled config too, which is how credentials are checked before it is enabled", async () => {
            state.providers[0].enabled = false;
            queue(TEST);
            await run(runner());
            expect(kube.writes()).toEqual([`CREATE ${JOBS}`]);
        });
    });

    describe("a takeover", () => {
        it("waits for the regular endpoint to hold the records, then writes the temporary endpoint with the ownership records, then the Job", async () => {
            queue(TAKEOVER);
            // The endpoint isn't there, then lacks the record, then has the name under another type.
            expect(await run(runner())).toEqual({ pending: true });
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("endpoint") });
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            await run(runner());
            regularEndpoint({ dnsName: "example.com", recordType: "TXT" });
            await run(runner());
            expect(kube.writes()).toEqual([]);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            expect(await run(runner())).toEqual({ pending: true });
            // The ownership records exist before the Job that uses them, and the Job is the takeover's.
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
            expect(kube.objects.get(TEMPORARY)).toEqual(operationEndpoint(TAKEOVER, "cloudflare", state.ownerId, settings));
            expect(JSON.stringify(kube.objects.get(TEMPORARY))).toContain(`external-dns/resource=crd/rapidmx/mail-domain-example-com`);
            expect(kube.objects.get(JOB)).toEqual(operationJob(TAKEOVER, state.providers[0], settings, []));
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("Taking over") });
        });

        it("keeps the temporary endpoint while the Job runs and deletes it as soon as the Job is finished, reporting the takeover done", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            kube.calls = [];
            await run(runner());
            expect(kube.writes()).toEqual([]);
            complete();
            expect(await run(runner())).toEqual({ pending: false });
            expect(result()).toEqual({ state: "succeeded", message: expect.stringContaining("taken over") });
            expect(kube.writes()).toEqual([`DELETE ${TEMPORARY}`]);
            expect(kube.objects.has(JOB)).toBe(true);
            expect(kube.objects.has(REGULAR)).toBe(true);
        });

        it("deletes the temporary endpoint of a failed Job as well", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            finish([{ type: "Failed", status: "True", message: "boom" }]);
            await run(runner());
            expect(result()).toMatchObject({ state: "failed" });
            expect(kube.objects.has(TEMPORARY)).toBe(false);
        });

        it("fails a takeover that names no endpoint set, or one this provider doesn't publish, or carries no records", async () => {
            queue({ ...TAKEOVER, endpointSetId: undefined });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation names no endpoint set." });
            ledger.clear();
            queue({ ...TAKEOVER, endpointSetId: "hosts-other" });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The endpoint set isn't published through this provider config." });
            ledger.clear();
            state.endpointSets[0].providerUid = "someone-else";
            queue(TAKEOVER);
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The endpoint set isn't published through this provider config." });
            ledger.clear();
            state.endpointSets[0].providerUid = "cloudflare-main";
            queue({ ...TAKEOVER, records: [] });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation has no records." });
            ledger.clear();
            queue({ ...TAKEOVER, records: undefined });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation has no records." });
            expect(kube.writes()).toEqual([]);
        });

        it("fails at once a takeover of records the state's endpoint set no longer holds, which the regular endpoint would never get", async () => {
            // The domain opted out before the takeover started: the set has no apex MX any more.
            state.endpointSets[0].records = state.endpointSets[0].records.filter((r) => r.recordType !== "MX");
            queue(TAKEOVER);
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The domain's endpoint set no longer holds the records." });
            expect(kube.writes()).toEqual([]);
        });

        it("fails a takeover of records its provider can't keep", async () => {
            state.providers[0] = { ...state.providers[0], type: "rfc2136", options: {}, credentials: { keys: ["tsigSecret"], generation: 1 } };
            queue(TAKEOVER);
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The provider can't keep any of the records." });
            expect(kube.writes()).toEqual([]);
        });
    });

    describe("a restore", () => {
        const present = { dnsName: "example.com", recordType: "TXT" };
        const running = { readyReplicas: 1, observedGeneration: 1 };

        it("waits until the regular instance has removed the set: its endpoint without the TXT record, the instance running, and a sync interval since", async () => {
            queue(RESTORE);
            const r = runner();
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            instance(running);
            // The first pass sees the set removed and starts the wait.
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("remove the set") });
            expect(kube.writes()).toEqual([]);
            clock += 119999;
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 1 });
            expect(kube.writes()).toEqual([]);
            clock += 1;
            expect(await run(r)).toEqual({ pending: true });
            // Only the kept values, with no ownership record.
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
            expect(kube.objects.get(TEMPORARY)).toEqual(operationEndpoint(RESTORE, "cloudflare", state.ownerId, settings));
            expect(JSON.stringify(kube.objects.get(TEMPORARY))).not.toContain("heritage=");
            expect(kube.objects.get(JOB)).toEqual(operationJob(RESTORE, state.providers[0], settings, []));
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("Restoring") });
        });

        it("does not start while the set is still in the regular endpoint", async () => {
            queue(RESTORE);
            const r = runner();
            regularEndpoint(present);
            instance(running);
            clock += 3600000;
            expect(await run(r)).toEqual({ pending: true });
            expect(kube.writes()).toEqual([]);
        });

        it("counts the interval from the first time it saw the set removed, and starts over if it is back or the instance stops", async () => {
            queue(RESTORE);
            const r = runner();
            instance(running);
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            await run(r);
            clock += 100000;
            // The set came back: the wait starts over.
            regularEndpoint(present);
            await run(r);
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            clock += 100000;
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
            // The instance stopped (disabled, rolling): starts over again.
            clock += 100000;
            instance({ readyReplicas: 0, observedGeneration: 1 });
            await run(r);
            instance(running);
            clock += 100000;
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
            expect(kube.writes()).toEqual([]);
        });

        it("waits for an instance that isn't ready, is older than its Deployment, has no status or isn't there", async () => {
            queue(RESTORE);
            const r = runner();
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            clock += 3600000;
            // Not there, no status, no ready replica, a status older than the Deployment's spec.
            await run(r);
            instance({});
            await run(r);
            instance({ readyReplicas: 0, observedGeneration: 1 });
            await run(r);
            instance({ readyReplicas: 1, observedGeneration: 1 }, 2);
            await run(r);
            instance({ observedGeneration: 1 });
            await run(r);
            kube.put(DEPLOYMENT, { status: { readyReplicas: 1 } });
            await run(r);
            expect(kube.writes()).toEqual([]);
            expect(result()).toMatchObject({ state: "running" });
        });

        it("waits for the regular instance to have read the endpoint without the set (its observedGeneration), not only for it to be ready", async () => {
            queue(RESTORE);
            const r = runner();
            instance(running);
            const endpoint = (observedGeneration?: number) =>
                kube.put(REGULAR, {
                    metadata: { generation: 3 } as never,
                    ...(observedGeneration !== undefined ? { status: { observedGeneration } } : {}),
                    spec: { endpoints: [{ dnsName: "other.example.com", recordType: "MX", targets: ["x"] }] },
                });
            // Not read yet (no status, then the generation before): the interval hasn't started, however long it has been.
            endpoint();
            await run(r);
            clock += 3600000;
            endpoint(2);
            expect(await run(r)).toEqual({ pending: true });
            // Read: the interval starts now.
            endpoint(3);
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
            clock += 120000;
            expect(await run(r)).toEqual({ pending: true });
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
        });

        it("does not wait for an endpoint that no longer exists (the domain was deleted): the instance deleted the set with it", async () => {
            queue(RESTORE);
            const r = runner();
            instance(running);
            await run(r);
            clock += 120000;
            await run(r);
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
        });

        it("needs the credentials Secret too, and fails a restore without an endpoint set or records", async () => {
            queue(RESTORE);
            regularEndpoint();
            instance(running);
            kube.objects.delete(SECRET);
            clock += 3600000;
            await run(runner());
            await run(runner());
            expect(kube.writes()).toEqual([]);
            expect(result()).toEqual({ state: "running", message: expect.stringContaining("credentials") });
            queue({ ...RESTORE, endpointSetId: undefined });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation names no endpoint set." });
            ledger.clear();
            queue({ ...RESTORE, records: [] });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation has no records." });
        });

        it("fails an operation whose endpoint set id could not be an object name, which would otherwise become part of a request path", async () => {
            queue({ ...RESTORE, endpointSetId: "../../secrets/x" });
            await run(runner());
            expect(result()).toEqual({ state: "failed", message: "The operation's endpoint set id is malformed." });
            expect(kube.calls.some((c) => c.includes("secrets/x"))).toBe(false);
            expect(kube.writes()).toEqual([]);
        });

        it("forgets what a restore has seen when the Lease is lost, so a re-acquired Lease waits a whole interval again", async () => {
            queue(RESTORE);
            instance(running);
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            const r = runner();
            await run(r);
            clock += 100000;
            r.forget();
            clock += 100000;
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
            expect(kube.writes()).toEqual([]);
        });

        it("forgets the wait of an operation the state no longer lists", async () => {
            queue(RESTORE);
            instance(running);
            regularEndpoint({ dnsName: "other.example.com", recordType: "MX" });
            const r = runner();
            await run(r);
            clock += 100000;
            queue();
            await run(r);
            // Listed again 100 s later: a new wait, not the one that was nearly over.
            queue(RESTORE);
            clock += 100000;
            expect(await run(r)).toEqual({ pending: true, nextAt: clock + 120000 });
        });
    });

    describe("after a restart or losing the Lease", () => {
        it("reads the result of a Job that ran already instead of running it again", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            complete();
            // A new process: the ledger is empty, the Job is not.
            ledger = new OperationLedger();
            kube.calls = [];
            expect(await run(runner())).toEqual({ pending: false });
            expect(result()).toMatchObject({ state: "succeeded" });
            expect(kube.writes()).toEqual([`DELETE ${TEMPORARY}`]);
            expect(kube.writes().some((w) => w.startsWith("CREATE"))).toBe(false);
        });

        it("picks up a Job that is still running", async () => {
            queue(TEST);
            await run(runner());
            ledger.clear();
            expect(await run(runner())).toEqual({ pending: true });
            expect(result()).toMatchObject({ state: "running" });
        });
    });

    describe("the Kubernetes writes", () => {
        it("tolerates a Job that already exists, created between its list and its create", async () => {
            queue(TEST);
            const r = runner();
            const create = kube.client.create;
            kube.client.create = async (path, body) => {
                kube.put(`${path}/${body.metadata.name}`, body);
                return create(path, body);
            };
            expect(await run(r)).toEqual({ pending: true });
            expect(result()).toMatchObject({ state: "running" });
            expect(logged("reconcile_failed")).toEqual([]);
        });

        it("logs a failed write, goes on with the other operations and reports the pass pending", async () => {
            const second = { ...TEST, id: "op-2" };
            queue(TEST, second);
            kube.failures.set(`CREATE ${JOBS}`, new KubeError("quota exceeded", 403, "Forbidden"));
            expect(await run(runner())).toEqual({ pending: true });
            expect(result()).toBeUndefined();
            expect(result("op-2")).toBeUndefined();
            expect(logged("reconcile_failed")).toEqual([
                expect.objectContaining({ step: "run", kind: "Operation", operationId: "op-1" }),
                expect.objectContaining({ step: "run", kind: "Operation", operationId: "op-2" }),
            ]);
        });

        it("logs a read it can't make (the Secret, the regular endpoint) and tries the operation again, rather than taking it for missing", async () => {
            queue(TAKEOVER);
            kube.failures.set(`META ${SECRET}`, new KubeError("unavailable", 503));
            expect(await run(runner())).toEqual({ pending: true });
            kube.failures.clear();
            kube.failures.set(`GET ${REGULAR}`, new KubeError("unavailable", 503));
            expect(await run(runner())).toEqual({ pending: true });
            expect(logged("reconcile_failed")).toHaveLength(2);
            expect(result()).toBeUndefined();
            expect(kube.writes()).toEqual([]);
        });

        it("throws when it can't list what it manages, so the pass is retried", async () => {
            queue(TEST);
            kube.failures.set(`GET ${JOBS}`, new KubeError("unavailable", 503));
            await expect(run(runner())).rejects.toThrow("unavailable");
            kube.failures.clear();
            kube.failures.set(`GET ${ENDPOINTS}`, new KubeError("unavailable", 503));
            await expect(run(runner())).rejects.toThrow("unavailable");
        });

        it("writes nothing it may not: every write asks the gate first, and the pass ends", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            let allowed = 1;
            // The temporary endpoint is allowed, the Job is not.
            await expect(runner().run(state, () => allowed-- > 0)).rejects.toBeInstanceOf(NotWriterError);
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`]);
            kube = new FakeKube();
            secretReady();
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            writable = false;
            await expect(run(runner())).rejects.toBeInstanceOf(NotWriterError);
            expect(kube.writes()).toEqual([]);
            expect(ledger.get("op-1")).toBeUndefined();
        });

        it("records no result it may not report: after the Lease is lost the ledger stays empty", async () => {
            queue(TEST);
            await run(runner());
            complete();
            writable = false;
            expect(await run(runner())).toEqual({ pending: false });
            // Only the running result recorded before the Lease was lost; the finished one isn't recorded without it.
            expect(result()).toMatchObject({ state: "running" });
        });

        it("records a result only for an operation the latest desired state still lists", async () => {
            queue(TEST);
            // A newer state arrived during the pass, without the operation.
            latest = { ...state, operations: [] };
            await run(runner());
            expect(result()).toBeUndefined();
            latest = undefined;
            await run(runner());
            expect(result()).toBeUndefined();
        });

        it("starts nothing for an operation the latest desired state no longer lists (cancelled while the pass ran)", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            latest = { ...state, operations: [] };
            expect(await run(runner())).toEqual({ pending: false });
            expect(kube.writes()).toEqual([]);
            latest = undefined;
            await run(runner());
            expect(kube.writes()).toEqual([]);
        });
    });

    describe("cleaning up", () => {
        it("deletes the Job of an operation the state no longer lists, with its pods, and its temporary endpoint", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            queue();
            kube.calls = [];
            expect(await run(runner())).toEqual({ pending: false });
            expect(kube.writes().sort()).toEqual([`DELETE ${JOB}?propagationPolicy=Background`, `DELETE ${TEMPORARY}`].sort());
            expect(kube.objects.has(JOB)).toBe(false);
            expect(kube.objects.has(TEMPORARY)).toBe(false);
            expect(kube.objects.has(REGULAR)).toBe(true);
        });

        it("deletes a temporary endpoint nothing is using, left by a controller that stopped before it could", async () => {
            queue(TAKEOVER);
            kube.objects.delete(SECRET);
            kube.put(TEMPORARY, { metadata: { labels: { ...jobLabels, "rapidmx.io/dns-operation": "71a0ef7195df4865" } }, spec: { endpoints: [] } });
            await run(runner());
            expect(kube.writes()).toEqual([`DELETE ${TEMPORARY}`]);
        });

        it("keeps the temporary endpoint when the answer to the Job's creation is lost: the Job may exist, and must find its endpoint", async () => {
            queue(RESTORE);
            instance({ readyReplicas: 1, observedGeneration: 1 });
            const r = runner();
            await run(r);
            clock += 120000;
            // The API server commits the Job and the answer times out.
            const create = kube.client.create;
            kube.client.create = async (path, body) => {
                await create(path, body);
                throw new KubeError("timeout", 504, "Timeout");
            };
            kube.calls = [];
            expect(await run(r)).toEqual({ pending: true });
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
            expect(kube.objects.has(JOB)).toBe(true);
            expect(kube.objects.has(TEMPORARY)).toBe(true);
            // The next pass reads the Job (running); only when it finished does the endpoint go.
            kube.calls = [];
            expect(await run(r)).toEqual({ pending: true });
            expect(kube.writes()).toEqual([]);
            complete();
            await run(r);
            expect(kube.writes()).toEqual([`DELETE ${TEMPORARY}`]);
            expect(result()).toMatchObject({ state: "succeeded" });
        });

        it("keeps the temporary endpoint of a Job that could not be created while the operation is listed, and deletes both once it is not", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            kube.failures.set(`CREATE ${JOBS}`, new KubeError("quota exceeded", 403, "Forbidden"));
            expect(await run(runner())).toEqual({ pending: true });
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
            // Tried again by the next pass, which writes the Job once it can.
            kube.failures.clear();
            kube.calls = [];
            await run(runner());
            expect(kube.writes()).toEqual([`APPLY ${TEMPORARY}`, `CREATE ${JOBS}`]);
            // The server dropped the operation: both go.
            queue();
            kube.calls = [];
            await run(runner());
            expect(kube.writes().sort()).toEqual([`DELETE ${JOB}?propagationPolicy=Background`, `DELETE ${TEMPORARY}`].sort());
        });

        it("never deletes the regular endpoints, nor an object that isn't labelled for this release", async () => {
            queue();
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            kube.put(`${ENDPOINTS}/foreign`, { metadata: { labels: { "rapidmx.io/dns-operation": "abc" } } });
            kube.put(`${JOBS}/foreign`, { metadata: { labels: { "app.kubernetes.io/instance": "other" } } });
            await run(runner());
            expect(kube.writes()).toEqual([]);
        });

        it("keeps the Job and endpoint it could not delete for the next pass, and reports the pass pending", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            queue();
            kube.failures.set("DELETE", new KubeError("forbidden", 403, "Forbidden"));
            expect(await run(runner())).toEqual({ pending: true });
            expect(logged("reconcile_failed")).toHaveLength(2);
            kube.failures.clear();
            expect(await run(runner())).toEqual({ pending: false });
            expect(kube.objects.has(JOB)).toBe(false);
        });

        it("tolerates an object that is gone by the time it deletes it", async () => {
            queue(TAKEOVER);
            regularEndpoint({ dnsName: "example.com", recordType: "MX" });
            await run(runner());
            queue();
            const del = kube.client.delete;
            kube.client.delete = async (path) => {
                await del(path);
                throw new KubeError("not found", 404, "NotFound");
            };
            expect(await run(runner())).toEqual({ pending: false });
            expect(logged("reconcile_failed")).toEqual([]);
        });
    });
});
