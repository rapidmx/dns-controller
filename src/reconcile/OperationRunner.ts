///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DesiredStateV1, DnsProviderV1, EndpointSetV1, OperationV1 } from "../api/v1.js";
import { isKubeStatus, type KubeClient } from "../kube/KubeClient.js";
import type { Logger } from "../log.js";
import { listManaged } from "./listManaged.js";
import {
    ANNOTATION_CREDENTIALS_GENERATION,
    credentialsProblem,
    credentialsSecretName,
    deploymentName,
    dnsEndpointName,
    ENDPOINT_SET_ID,
    endpointEntries,
    EXTERNAL_DNS_CONTAINER,
    FIELD_MANAGER,
    isOurSecret,
    LABEL_OPERATION,
    nestedZones,
    operationEndpoint,
    operationJob,
    operationName,
    type DnsEndpointEntry,
    type ManifestSettings,
} from "./manifests.js";
import { NotWriterError } from "./NotWriterError.js";
import type { OperationLedger, OperationResult } from "./OperationLedger.js";
import { readyReplicas, type ListedDeployment } from "./StatusCollector.js";

export interface OperationRunnerOptions {
    kube: Pick<KubeClient, "apply" | "create" | "get" | "getMetadata" | "delete">;
    settings: ManifestSettings;
    log: Logger;
    /** Where the results go, for the status report. */
    ledger: OperationLedger;
    /** The newest desired state the controller has: a result is recorded only for an operation it still lists. */
    latest: () => DesiredStateV1 | undefined;
    /** How long a restore waits, once the regular instance is running without the set, for that instance to have synced (one interval and a margin). */
    restoreDelayMs?: number;
    now?: () => number;
}

/** What one run over the operations leaves to do: `pending` while an operation is not finished or a write failed; `nextAt` when a waiting restore is due. */
export interface OperationsOutcome {
    pending: boolean;
    nextAt?: number;
}

/** What one run is doing: the state and gate it was given, and what it found. */
interface Run {
    state: DesiredStateV1;
    mayWrite: () => boolean;
    /** The names of the Jobs (and so of the temporary endpoints) in use: observed running, or just created. */
    active: Set<string>;
    /** The names of the temporary endpoints there are: listed, or written by this run. */
    endpoints: Set<string>;
    pending: boolean;
    nextAt?: number;
}

/** An object a list returned. It carries the controller's labels: the list selected it by them. */
interface Listed {
    metadata: { name: string; labels?: Record<string, string> };
}

interface JobCondition {
    type?: string;
    status?: string;
    reason?: string;
    message?: string;
}

interface ListedJob extends Listed {
    status?: { conditions?: JobCondition[] };
}

/** A pod as a list returns it; every field is optional because the answer is only read, never trusted. */
interface ListedPod {
    status?: { containerStatuses?: { name?: string; state?: { terminated?: { message?: string; reason?: string; exitCode?: number }; waiting?: { reason?: string; message?: string } } }[] };
}

/** An endpoint as a read returns it. */
interface ReadEndpoint {
    metadata?: { generation?: number };
    status?: { observedGeneration?: number };
    spec?: { endpoints?: { dnsName?: string; recordType?: string }[] };
}

const RUNNING: Record<OperationV1["type"], string> = {
    test: "Running external-dns in a dry run.",
    takeover: "Taking over the records.",
    restore: "Restoring the values.",
};

const SUCCEEDED: Record<OperationV1["type"], string> = {
    test: "The credentials work: external-dns listed the zones in a dry run.",
    takeover: "The records are taken over: written with their ownership records.",
    restore: "The values are restored, unowned.",
};

const WAIT_CREDENTIALS = "Waiting for the provider's credentials to be written to its Secret.";
const WAIT_ENDPOINT = "Waiting for the domain's endpoint to be applied.";
const WAIT_REMOVAL = "Waiting for the provider's external-dns instance to remove the set.";

/** The longest reason taken from a pod: the server keeps 2000 characters, and the last log lines hold more than the reason. */
const MAX_DETAIL = 500;

/**
 * The last error external-dns logged (its logs are JSON lines, `level` and `msg`), or undefined when it logged none: what a
 * failed pod's termination message (its last log lines, `FallbackToLogsOnError`) is read for. Any other line says nothing
 * of the cause (an OOM-killed or killed process has its log tail in the message too).
 */
function lastErrorLine(logs: string): string | undefined {
    const lines: string[] = logs
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    for (const line of [...lines].reverse()) {
        try {
            const entry = JSON.parse(line) as { level?: unknown; msg?: unknown };
            if ((entry.level === "error" || entry.level === "fatal") && typeof entry.msg === "string") {
                return entry.msg;
            }
        } catch {
            // Not a JSON line (a panic's text): not an error entry.
        }
    }
    return undefined;
}

/** Why a Job's pod failed, from what it says of itself: the error in its log, else how its container ended or why it never started. */
function podProblem(pods: ListedPod[]): string | undefined {
    for (const pod of pods) {
        const state = pod.status?.containerStatuses?.find((container) => container.name === EXTERNAL_DNS_CONTAINER)?.state;
        const terminated = state?.terminated;
        const logged: string | undefined = terminated?.message ? lastErrorLine(terminated.message) : undefined;
        if (logged) {
            return logged;
        }
        if (terminated?.reason) {
            return terminated.exitCode !== undefined ? `${terminated.reason} (exit code ${terminated.exitCode})` : terminated.reason;
        }
        const waiting = state?.waiting;
        if (waiting?.reason) {
            return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
        }
    }
    return undefined;
}

/** Whether the regular `endpoint` holds `entry`'s name and type. */
function holds(endpoint: ReadEndpoint | undefined, entry: DnsEndpointEntry): boolean {
    return endpoint?.spec?.endpoints?.some((e) => e.dnsName === entry.dnsName && e.recordType === entry.recordType) === true;
}

/**
 * Runs the operations the desired state lists (spec 9.3, 9.5; phase C4) as one-shot Jobs from the pinned image and reports
 * each one's result:
 *
 * - **test:** a dry run (`--dry-run --once`) with the provider's credentials, which lists the zones and so proves them.
 * - **takeover:** the noop registry with `--policy=upsert-only --once` writes the operation's records and their
 * ownership records from a temporary DNSEndpoint, after which the regular instance owns them. It starts only once the
 * regular endpoint holds those records: the regular instance would otherwise delete what it then finds owned and not
 * wanted. Also the only way to create an MX where an unowned TXT set blocks the creation.
 * - **restore:** the same Job with the SPF and the kept values and no ownership record, so the set is unowned again. It
 * starts only once the regular instance, running, has had a sync interval since the regular endpoint stopped holding the
 * set: the instance deletes the set and its ownership record, and the Job would race that.
 *
 * An operation waits (reported running, with why) for the provider's credentials Secret too. The Job stays after it
 * finished, so a controller that restarts, or takes the Lease again, reads its result instead of running it again; Jobs
 * and temporary endpoints go once the server stops listing the operation, and a temporary endpoint as soon as its Job is
 * finished. What it can't run (the provider is gone or can't run, the operation is malformed, the provider keeps none of
 * its records) fails at once, with the reason.
 *
 * Writes go through the gate each run is given, asked immediately before each one. A failed write is logged and the
 * operation tried again on the next pass.
 */
export class OperationRunner {
    private readonly restoreDelayMs: number;
    private readonly now: () => number;
    /** When a restore first saw the regular instance running without its set: the interval is counted from then. In memory, so a restart waits again. */
    private readonly removalSeen: Map<string, number> = new Map();

    constructor(private readonly options: OperationRunnerOptions) {
        this.restoreDelayMs = options.restoreDelayMs ?? 120000;
        this.now = options.now ?? Date.now;
    }

    private collection(apiPrefix: string, resource: string): string {
        return `${apiPrefix}/namespaces/${this.options.settings.namespace}/${resource}`;
    }

    private get jobs(): string {
        return this.collection("/apis/batch/v1", "jobs");
    }

    private get endpoints(): string {
        return this.collection("/apis/externaldns.k8s.io/v1alpha1", "dnsendpoints");
    }

    /** Forgets what in-memory waits have seen: called when the Lease is lost, so a re-acquired one counts a whole interval again. */
    forget(): void {
        this.removalSeen.clear();
    }

    /**
     * One run over `state`'s operations, then the cleaning up of what no operation needs any more. Throws
     * `NotWriterError` when `mayWrite` says no at a write, and what a failed list throws; a failing operation is logged and
     * leaves the run `pending`.
     */
    async run(state: DesiredStateV1, mayWrite: () => boolean): Promise<OperationsOutcome> {
        const { settings } = this.options;
        const jobs: ListedJob[] = await listManaged<ListedJob>(this.options.kube, this.jobs, settings);
        const temporary: Listed[] = (await listManaged<Listed>(this.options.kube, this.endpoints, settings)).filter((e) => e.metadata.labels?.[LABEL_OPERATION] !== undefined);
        const run: Run = { state, mayWrite, active: new Set(), endpoints: new Set(temporary.map((e) => e.metadata.name)), pending: false };
        for (const operation of state.operations) {
            await this.attempt(run, { step: "run", kind: "Operation", operationId: operation.id }, () => this.handle(run, operation, jobs));
        }
        const wanted: Set<string> = new Set(state.operations.map((operation) => operationName(settings, operation.id)));
        for (const job of jobs.filter((j) => !wanted.has(j.metadata.name))) {
            // Background, so the pods go with the Job (a Job deleted through the API orphans them by default).
            await this.attempt(run, { step: "delete", kind: "Job", name: job.metadata.name }, () =>
                this.remove(run, `${this.jobs}/${job.metadata.name}?propagationPolicy=Background`)
            );
        }
        for (const name of [...run.endpoints].filter((n) => !run.active.has(n))) {
            await this.attempt(run, { step: "delete", kind: "DNSEndpoint", name }, () => this.remove(run, `${this.endpoints}/${name}`));
        }
        const ids: Set<string> = new Set(state.operations.map((operation) => operation.id));
        for (const id of [...this.removalSeen.keys()].filter((k) => !ids.has(k))) {
            this.removalSeen.delete(id);
        }
        return { pending: run.pending, ...(run.nextAt !== undefined ? { nextAt: run.nextAt } : {}) };
    }

    /** Runs `call`; a failure is logged and leaves the run pending, except losing the right to write, which ends it. */
    private async attempt(run: Run, step: Record<string, string>, call: () => Promise<void>): Promise<void> {
        try {
            await call();
        } catch (err) {
            if (err instanceof NotWriterError) {
                throw err;
            }
            run.pending = true;
            this.options.log.error("reconcile_failed", { ...step, error: err });
        }
    }

    /** Runs `call` once it has checked, immediately before, that it may write. */
    private async write<T>(run: Run, call: () => Promise<T>): Promise<T> {
        if (!run.mayWrite()) {
            throw new NotWriterError();
        }
        return call();
    }

    /** Deletes `path`; one already gone counts as deleted. */
    private async remove(run: Run, path: string): Promise<void> {
        try {
            await this.write(run, () => this.options.kube.delete(path));
        } catch (err) {
            if (!isKubeStatus(err, 404)) {
                throw err;
            }
        }
    }

    /** What `read` returns, or undefined when the API server says the object isn't there. */
    private async optional<T>(read: () => Promise<T>): Promise<T | undefined> {
        try {
            return await read();
        } catch (err) {
            if (isKubeStatus(err, 404)) {
                return undefined;
            }
            throw err;
        }
    }

    /** Records the operation's result, but only while this controller may write (it holds the Lease) and the server still lists the operation. */
    private note(run: Run, operation: OperationV1, state: OperationResult["state"], message: string): void {
        if (run.mayWrite() && this.options.latest()?.operations.some((o) => o.id === operation.id)) {
            this.options.ledger.record(operation.id, state, message);
        }
    }

    /** Ends the operation with `state` and the reason or outcome. */
    private finish(run: Run, operation: OperationV1, state: "succeeded" | "failed", message: string): void {
        this.options.log.info("operation_finished", { operationId: operation.id, type: operation.type, providerUid: operation.providerUid, state, message });
        this.note(run, operation, state, message);
    }

    private async handle(run: Run, operation: OperationV1, jobs: ListedJob[]): Promise<void> {
        const { settings } = this.options;
        const recorded: OperationResult | undefined = this.options.ledger.get(operation.id);
        if (recorded !== undefined && recorded.state !== "running") {
            return;
        }
        const name: string = operationName(settings, operation.id);
        const job: ListedJob | undefined = jobs.find((j) => j.metadata.name === name);
        if (job) {
            await this.observe(run, operation, job);
            return;
        }
        const provider: DnsProviderV1 | undefined = run.state.providers.find((p) => p.uid === operation.providerUid);
        const refusal: string | undefined = this.refusal(run.state, operation, provider);
        if (refusal !== undefined) {
            this.finish(run, operation, "failed", refusal);
            return;
        }
        const config = provider as DnsProviderV1;
        const entries: DnsEndpointEntry[] = endpointEntries(operation.records ?? [], config.type);
        if (operation.type !== "test" && entries.length === 0) {
            this.finish(run, operation, "failed", "The provider can't keep any of the records.");
            return;
        }
        // Waiting for the regular endpoint to hold records the state itself no longer lists (the domain opted out meanwhile) would never end.
        if (operation.type === "takeover" && !this.stateHolds(run.state, operation, config, entries)) {
            this.finish(run, operation, "failed", "The domain's endpoint set no longer holds the records.");
            return;
        }
        // The server has dropped the operation (cancelled, or finished in a newer state) since this pass's state: it must not start now.
        if (!this.options.latest()?.operations.some((o) => o.id === operation.id)) {
            return;
        }
        const waiting: string | undefined = await this.waiting(run, operation, config, entries);
        if (waiting !== undefined) {
            this.note(run, operation, "running", waiting);
            run.pending = true;
            return;
        }
        await this.launch(run, operation, config, name);
    }

    /** Why the operation can never run, or undefined. Such an operation fails at once: waiting would not change it. */
    private refusal(state: DesiredStateV1, operation: OperationV1, provider: DnsProviderV1 | undefined): string | undefined {
        if (!provider) {
            return "The provider config isn't in the desired state.";
        }
        const problem: string | undefined = credentialsProblem(provider);
        if (problem !== undefined) {
            return `The provider config can't run: ${problem}.`;
        }
        if (operation.type === "test") {
            return undefined;
        }
        if (!operation.endpointSetId) {
            return "The operation names no endpoint set.";
        }
        // The id becomes part of an object name and of a path, so it is held to what the state's own ids are held to.
        if (!ENDPOINT_SET_ID.test(operation.endpointSetId)) {
            return "The operation's endpoint set id is malformed.";
        }
        // A takeover's ownership records name the regular endpoint of the set: it has to be this provider's.
        if (operation.type === "takeover" && state.endpointSets.find((set) => set.id === operation.endpointSetId)?.providerUid !== provider.uid) {
            return "The endpoint set isn't published through this provider config.";
        }
        return operation.records?.length ? undefined : "The operation has no records.";
    }

    /** Whether the state's own endpoint set (the one the regular endpoint is applied from) holds every one of the takeover's `entries`. */
    private stateHolds(state: DesiredStateV1, operation: OperationV1, provider: DnsProviderV1, entries: DnsEndpointEntry[]): boolean {
        // The set is there: `refusal()` found it, published through this provider.
        const set = state.endpointSets.find((s) => s.id === operation.endpointSetId) as EndpointSetV1;
        const stated: ReadEndpoint = { spec: { endpoints: endpointEntries(set.records, provider.type) } };
        return entries.every((entry) => holds(stated, entry));
    }

    /** What the Job has to wait for (a reason to report), or undefined when it can start. */
    private async waiting(run: Run, operation: OperationV1, provider: DnsProviderV1, entries: DnsEndpointEntry[]): Promise<string | undefined> {
        if (!(await this.credentialsReady(provider))) {
            return WAIT_CREDENTIALS;
        }
        if (operation.type === "test") {
            return undefined;
        }
        const regular: ReadEndpoint | undefined = await this.optional(() =>
            this.options.kube.get<ReadEndpoint>(`${this.endpoints}/${dnsEndpointName(this.options.settings, operation.endpointSetId as string)}`)
        );
        if (operation.type === "takeover") {
            return entries.every((entry) => holds(regular, entry)) ? undefined : WAIT_ENDPOINT;
        }
        return (await this.removalPending(run, operation, provider, entries, regular)) ? WAIT_REMOVAL : undefined;
    }

    /**
     * Whether a restore still has to wait for the regular instance to remove the set (9.5, step 1): the regular endpoint
     * must no longer hold it and the instance must have read that (its `observedGeneration`) and be running (a disabled
     * one deletes nothing), and an interval must have passed since all were seen. The controller can't see the provider's records, so this is the same wait it gives a
     * deleted provider's instance. Seeing the set back, or the instance not running, starts the count over.
     */
    private async removalPending(
        run: Run,
        operation: OperationV1,
        provider: DnsProviderV1,
        entries: DnsEndpointEntry[],
        regular: ReadEndpoint | undefined
    ): Promise<boolean> {
        const instance: ListedDeployment | undefined = await this.optional(() =>
            this.options.kube.get<ListedDeployment>(`${this.collection("/apis/apps/v1", "deployments")}/${deploymentName(this.options.settings, provider.uid)}`)
        );
        // The endpoint stopped holding the set, but the instance has not read that generation yet (it writes `observedGeneration` as it reads the resource).
        const generation: number | undefined = regular?.metadata?.generation;
        const unread: boolean = generation !== undefined && (regular?.status?.observedGeneration ?? 0) < generation;
        if (unread || entries.some((entry) => holds(regular, entry)) || readyReplicas(instance) === 0) {
            this.removalSeen.delete(operation.id);
            return true;
        }
        const since: number = this.removalSeen.get(operation.id) ?? this.now();
        this.removalSeen.set(operation.id, since);
        const due: number = since + this.restoreDelayMs;
        if (this.now() < due) {
            run.nextAt = Math.min(run.nextAt ?? due, due);
            return true;
        }
        return false;
    }

    /** Whether the provider's Secret is there at the generation the state lists (a config without credentials needs none). */
    private async credentialsReady(provider: DnsProviderV1): Promise<boolean> {
        if (!provider.credentials) {
            return true;
        }
        const secret = await this.optional(() =>
            this.options.kube.getMetadata<{ metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } }>(
                this.collection("/api/v1", "secrets") + `/${credentialsSecretName(this.options.settings, provider.uid)}`
            )
        );
        return (
            secret !== undefined &&
            isOurSecret(secret.metadata?.labels, provider.uid) &&
            Number(secret.metadata?.annotations?.[ANNOTATION_CREDENTIALS_GENERATION]) === provider.credentials.generation
        );
    }

    /** Writes the temporary endpoint, then the Job that reads it: the records are there before external-dns looks. */
    private async launch(run: Run, operation: OperationV1, provider: DnsProviderV1, name: string): Promise<void> {
        const { kube, settings, log } = this.options;
        // In use from the first write: a write whose answer is lost (a timeout) may have happened, and the Job it leaves must find its endpoint.
        run.active.add(name);
        if (operation.type !== "test") {
            run.endpoints.add(name);
            const endpoint = operationEndpoint(operation, provider.type, run.state.ownerId, settings);
            await this.write(run, () => kube.apply(`${this.endpoints}/${name}`, endpoint, { fieldManager: FIELD_MANAGER, force: true }));
        }
        try {
            await this.write(run, () => kube.create(this.jobs, operationJob(operation, provider, settings, nestedZones(provider, run.state.providers))));
        } catch (err) {
            // Created meanwhile (between the list and now): the Job is there, which is all that was wanted.
            if (!isKubeStatus(err, 409)) {
                throw err;
            }
        }
        log.info("operation_started", { operationId: operation.id, type: operation.type, providerUid: provider.uid, job: name });
        this.note(run, operation, "running", RUNNING[operation.type]);
        run.pending = true;
    }

    /** Reads the result of the operation's Job. */
    private async observe(run: Run, operation: OperationV1, job: ListedJob): Promise<void> {
        const condition = (type: string): JobCondition | undefined => job.status?.conditions?.find((c) => c.type === type && c.status === "True");
        if (condition("Complete")) {
            this.finish(run, operation, "succeeded", SUCCEEDED[operation.type]);
            return;
        }
        const failed: JobCondition | undefined = condition("Failed");
        if (failed) {
            this.finish(run, operation, "failed", await this.failure(job, failed));
            return;
        }
        run.active.add(job.metadata.name);
        this.note(run, operation, "running", RUNNING[operation.type]);
        run.pending = true;
    }

    /**
     * Why the Job failed: what external-dns logged last (the pod's termination message) or why its container never
     * started, else what Kubernetes says of the Job. The reason is the provider's own error text, never a credential:
     * external-dns doesn't log them.
     */
    private async failure(job: ListedJob, condition: JobCondition): Promise<string> {
        let detail: string | undefined;
        try {
            const pods = await this.options.kube.get<{ items?: ListedPod[] }>(
                `${this.collection("/api/v1", "pods")}?${new URLSearchParams({ labelSelector: `job-name=${job.metadata.name}` })}`
            );
            detail = podProblem(pods.items ?? []);
        } catch (err) {
            this.options.log.warn("operation_pods_unreadable", { job: job.metadata.name, error: err });
        }
        if (detail) {
            return `external-dns failed: ${detail.slice(0, MAX_DETAIL)}`;
        }
        const why: string = [condition.reason, condition.message].filter(Boolean).join(": ");
        return `The Job failed: ${(why || "no reason given").slice(0, MAX_DETAIL)}`;
    }
}
