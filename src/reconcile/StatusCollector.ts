///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isIP } from "node:net";
import type { DesiredStateV1, EndpointStatusV1, OperationStatusV1, ProviderStatusV1 } from "../api/v1.js";
import type { KubeClient } from "../kube/KubeClient.js";
import type { Logger } from "../log.js";
import { parseExternalDnsMetrics, type ExternalDnsMetrics } from "./ExternalDnsMetrics.js";
import { listManaged } from "./listManaged.js";
import { deploymentName, dnsEndpointName, EXTERNAL_DNS_CONTAINER, EXTERNAL_DNS_PORT, LABEL_NAME, LABEL_PROVIDER, type ManifestSettings } from "./manifests.js";
import { OperationLedger } from "./OperationLedger.js";

/** The per-provider, per-endpoint and per-operation entries of a status report (spec 7.3, 7.7). */
export interface StatusEntries {
    providers: ProviderStatusV1[];
    endpoints: EndpointStatusV1[];
    operations: OperationStatusV1[];
}

export interface StatusCollectorOptions {
    /** Read-only: the report only lists. */
    kube: Pick<KubeClient, "get">;
    settings: ManifestSettings;
    log: Logger;
    /** The results of the operations the controller runs; none is reported without one. */
    ledger?: OperationLedger;
    /** Scrapes the pods' `/metrics` (the global `fetch` unless a test brings its own). */
    fetch?: typeof fetch;
    /** How long one scrape may take, body included (5 s unless a test shortens it). */
    metricsTimeoutMs?: number;
    /** How many bytes of a metrics page are read before it is refused as too large (1 MiB unless a test lowers it). */
    metricsMaxBytes?: number;
}

/** An external-dns Deployment as a list returns it; every field is optional because the API server's answer is only read, never trusted. */
export interface ListedDeployment {
    metadata?: { name?: string; generation?: number };
    spec?: { template?: { spec?: { containers?: { name?: string; image?: unknown }[] } } };
    status?: { observedGeneration?: number; readyReplicas?: unknown; conditions?: { type?: string; status?: unknown; reason?: unknown; lastUpdateTime?: unknown }[] };
}

/** An external-dns pod as a list returns it. */
interface ListedPod {
    metadata?: { name?: unknown; labels?: Record<string, unknown>; deletionTimestamp?: unknown };
    status?: { phase?: unknown; podIP?: unknown };
}

/** What one pod's scrape came to: its numbers, or why there are none. */
interface Scraped {
    pod: string;
    metrics?: ExternalDnsMetrics;
    reason?: string;
}

const METRICS_TIMEOUT_MS = 5000;

/** A real v0.23.0 page is about 20 KB; the pods are third-party code holding the provider's credentials, so what they send is bounded. */
const METRICS_MAX_BYTES = 1024 * 1024;

/** A `DNSEndpoint` as a list returns it. */
interface ListedEndpoint {
    metadata?: { name?: string; generation?: unknown };
    status?: { observedGeneration?: unknown };
}

/** The metrics URL of a pod that is one of provider `uid`'s running instances, with its name; undefined for any other. */
function scrapeTarget(pod: ListedPod, uid: string): { name: string; url: string } | undefined {
    const labels = pod.metadata?.labels;
    const name: unknown = pod.metadata?.name;
    const ip: unknown = pod.status?.podIP;
    if (labels?.[LABEL_NAME] !== "external-dns" || labels[LABEL_PROVIDER] !== uid || typeof name !== "string") {
        return undefined;
    }
    // A terminating pod is on its way out; the address comes from the API server and goes into a URL, so it must be one.
    if (pod.status?.phase !== "Running" || pod.metadata?.deletionTimestamp !== undefined || typeof ip !== "string" || isIP(ip) === 0) {
        return undefined;
    }
    return { name, url: `http://${ip.includes(":") ? `[${ip}]` : ip}:${EXTERNAL_DNS_PORT}/metrics` };
}

/** Why a scrape failed, short and without the address: a timeout, the error's code (`ECONNREFUSED`), or its message. */
function reasonOf(err: unknown): string {
    const failure = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
    if (failure?.name === "TimeoutError") {
        return "timed out";
    }
    const code: unknown = failure?.cause?.code ?? failure?.code;
    if (typeof code === "string") {
        return code;
    }
    return err instanceof Error ? err.message : String(err);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The ready replicas the Deployment's status says, unless that status is of an older spec than the Deployment's now (or it isn't there). */
export function readyReplicas(deployment: ListedDeployment | undefined): number {
    const status: ListedDeployment["status"] = deployment?.status;
    const stale: boolean = (status?.observedGeneration ?? 0) < (deployment?.metadata?.generation ?? 0);
    return !stale && isCount(status?.readyReplicas) ? status.readyReplicas : 0;
}

/**
 * Reads what the controller reports besides itself (spec 7.7), from the namespace's objects, with two lists:
 *
 * - **Per provider:** its Deployment's ready replicas (none while the Deployment's status is older than its spec, or when
 * it isn't there), the image it runs and when it last rolled out: the `Progressing` condition's last update, but only
 * once the rollout completed (status `True`, reason `NewReplicaSetAvailable`). While one is under way the Deployment
 * controller moves that time on, and a failed one (`ProgressDeadlineExceeded`) sets it too, so neither is reported.
 * - **Per provider, from its pods' `/metrics`** (spec 7.7): the last successful sync, the registry, source and provider error
 * counts and the owner-mismatch records (`ExternalDnsMetrics`), scraped at the pod's IP on external-dns's port, every pod
 * side by side. The pod that synced last speaks for the provider (two exist only while a rollout replaces one). A pod
 * that cannot be read leaves the metrics out and says so in `lastError`; so does a provider whose syncs are failing.
 * - **Per endpoint set:** its `DNSEndpoint`'s generation, which is what the controller last applied, and the generation
 * external-dns has observed (`status.observedGeneration`, written when external-dns *reads* the resource, not when the
 * provider has applied it). A set whose `DNSEndpoint` isn't there is left out.
 * - **Per operation:** the result the ledger holds for each operation the state lists. Nothing is dropped here: the ledger
 * is pruned when a state arrives, not by a report that may be for an older one.
 *
 * A list that fails leaves its entries out, logged (`status_entries_failed`), instead of reporting what wasn't read.
 */
export class StatusCollector {
    private readonly ledger: OperationLedger;
    private readonly fetcher: typeof fetch;
    private readonly metricsTimeoutMs: number;
    private readonly metricsMaxBytes: number;

    constructor(private readonly options: StatusCollectorOptions) {
        this.ledger = options.ledger ?? new OperationLedger();
        this.fetcher = options.fetch ?? fetch;
        this.metricsTimeoutMs = options.metricsTimeoutMs ?? METRICS_TIMEOUT_MS;
        this.metricsMaxBytes = options.metricsMaxBytes ?? METRICS_MAX_BYTES;
    }

    async collect(state: DesiredStateV1): Promise<StatusEntries> {
        return {
            providers: await this.read("Deployment", () => this.providers(state)),
            endpoints: await this.read("DNSEndpoint", () => this.endpoints(state)),
            operations: this.operations(state),
        };
    }

    /** `read()`'s entries, or none (and a warning) when it fails. */
    private async read<T>(kind: string, read: () => Promise<T[]>): Promise<T[]> {
        try {
            return await read();
        } catch (err) {
            this.options.log.warn("status_entries_failed", { kind, error: err });
            return [];
        }
    }

    private collection(apiPrefix: string, resource: string): string {
        return `${apiPrefix}/namespaces/${this.options.settings.namespace}/${resource}`;
    }

    private async providers(state: DesiredStateV1): Promise<ProviderStatusV1[]> {
        const { kube, settings } = this.options;
        const listed: ListedDeployment[] = await listManaged<ListedDeployment>(kube, this.collection("/apis/apps/v1", "deployments"), settings);
        const byName: Map<string | undefined, ListedDeployment> = new Map(listed.map((d) => [d.metadata?.name, d]));
        const entries: ProviderStatusV1[] = state.providers.map((provider) => {
            const deployment: ListedDeployment | undefined = byName.get(deploymentName(settings, provider.uid));
            const entry: ProviderStatusV1 = { providerUid: provider.uid, readyReplicas: readyReplicas(deployment) };
            const image: unknown = deployment?.spec?.template?.spec?.containers?.find((c) => c.name === EXTERNAL_DNS_CONTAINER)?.image;
            if (typeof image === "string") {
                entry.image = image;
            }
            const progressing = deployment?.status?.conditions?.find((c) => c.type === "Progressing");
            const rolledOut: unknown = progressing?.status === "True" && progressing.reason === "NewReplicaSetAvailable" ? progressing.lastUpdateTime : undefined;
            if (typeof rolledOut === "string" && !Number.isNaN(Date.parse(rolledOut))) {
                entry.lastRolloutAt = new Date(rolledOut).toISOString();
            }
            return entry;
        });
        await this.scrapeProviders(entries);
        return entries;
    }

    /** Adds each provider's health from its pods' metrics to its entry; a failure is logged and leaves the entries as they are. */
    private async scrapeProviders(entries: ProviderStatusV1[]): Promise<void> {
        const { kube, settings, log } = this.options;
        if (entries.length === 0) {
            return;
        }
        let pods: ListedPod[];
        try {
            pods = await listManaged<ListedPod>(kube, this.collection("/api/v1", "pods"), settings);
        } catch (err) {
            log.warn("status_entries_failed", { kind: "Pod", error: err });
            return;
        }
        await Promise.all(entries.map((entry) => this.scrapeProvider(entry, pods)));
    }

    private async scrapeProvider(entry: ProviderStatusV1, pods: ListedPod[]): Promise<void> {
        const targets = pods.flatMap((pod) => scrapeTarget(pod, entry.providerUid) ?? []);
        const results: Scraped[] = await Promise.all(targets.map((target) => this.scrape(target.name, target.url)));
        for (const failed of results.filter((result) => result.metrics === undefined)) {
            this.options.log.warn("metrics_scrape_failed", { providerUid: entry.providerUid, pod: failed.pod, reason: failed.reason });
        }
        // The pod that synced last; the first of those that synced alike (or never).
        let best: Scraped | undefined;
        for (const result of results) {
            if (result.metrics && (best === undefined || (result.metrics.lastSyncAt ?? "") > (best.metrics?.lastSyncAt ?? ""))) {
                best = result;
            }
        }
        if (best?.metrics) {
            Object.assign(entry, best.metrics);
            const failing: number = best.metrics.providerErrors ?? 0;
            if (failing > 0) {
                // No count in the words: the server rewrites the provider's row only when its status changes, and a running count would change it every report.
            entry.lastError = "external-dns's syncs are failing (a provider error); see its log";
            }
        } else if (results.length > 0) {
            entry.lastError = `the metrics of pod ${results[0].pod} could not be read: ${results[0].reason}`;
        }
    }

    /** One pod's metrics page. The timeout covers the body too, so a pod that stalls half-way cannot hold a report up. */
    private async scrape(pod: string, url: string): Promise<Scraped> {
        try {
            const response: Response = await this.fetcher(url, { headers: { Accept: "text/plain;version=0.0.4;q=1,*/*;q=0.1" }, signal: AbortSignal.timeout(this.metricsTimeoutMs) });
            if (!response.ok) {
                return { pod, reason: `HTTP ${response.status}` };
            }
            const text: string | undefined = await this.readCapped(response);
            if (text === undefined) {
                return { pod, reason: "page too large" };
            }
            const metrics: ExternalDnsMetrics | undefined = parseExternalDnsMetrics(text);
            return metrics ? { pod, metrics } : { pod, reason: "not an external-dns metrics page" };
        } catch (err) {
            return { pod, reason: reasonOf(err) };
        }
    }

    /** The body as text, or undefined once it passes the size limit (the rest is not read: the stream is cancelled). */
    private async readCapped(response: Response): Promise<string | undefined> {
        if (!response.body) {
            return "";
        }
        const reader = response.body.getReader();
        const decoder: TextDecoder = new TextDecoder();
        let text: string = "";
        let size: number = 0;
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            size += chunk.value.byteLength;
            if (size > this.metricsMaxBytes) {
                await reader.cancel();
                return undefined;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    }

    private async endpoints(state: DesiredStateV1): Promise<EndpointStatusV1[]> {
        const { kube, settings } = this.options;
        const listed: ListedEndpoint[] = await listManaged<ListedEndpoint>(kube, this.collection("/apis/externaldns.k8s.io/v1alpha1", "dnsendpoints"), settings);
        const byName: Map<string | undefined, ListedEndpoint> = new Map(listed.map((e) => [e.metadata?.name, e]));
        const entries: EndpointStatusV1[] = [];
        for (const set of state.endpointSets) {
            const endpoint: ListedEndpoint | undefined = byName.get(dnsEndpointName(settings, set.id));
            const generation: unknown = endpoint?.metadata?.generation;
            if (!isCount(generation)) {
                continue;
            }
            const observed: unknown = endpoint?.status?.observedGeneration;
            entries.push({ endpointSetId: set.id, generation, ...(isCount(observed) ? { observedGeneration: observed } : {}) });
        }
        return entries;
    }

    private operations(state: DesiredStateV1): OperationStatusV1[] {
        return state.operations.flatMap((operation) => {
            const result = this.ledger.get(operation.id);
            return result ? [{ id: operation.id, ...result }] : [];
        });
    }
}
