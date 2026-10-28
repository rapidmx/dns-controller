///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DesiredStateV1, EndpointStatusV1, OperationStatusV1, ProviderStatusV1 } from "../api/v1.js";
import type { KubeClient } from "../kube/KubeClient.js";
import type { Logger } from "../log.js";
import { listManaged } from "./listManaged.js";
import { deploymentName, dnsEndpointName, EXTERNAL_DNS_CONTAINER, type ManifestSettings } from "./manifests.js";
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
}

/** An external-dns Deployment as a list returns it; every field is optional because the API server's answer is only read, never trusted. */
interface ListedDeployment {
    metadata?: { name?: string; generation?: number };
    spec?: { template?: { spec?: { containers?: { name?: string; image?: unknown }[] } } };
    status?: { observedGeneration?: number; readyReplicas?: unknown; conditions?: { type?: string; status?: unknown; reason?: unknown; lastUpdateTime?: unknown }[] };
}

/** A `DNSEndpoint` as a list returns it. */
interface ListedEndpoint {
    metadata?: { name?: string; generation?: unknown };
    status?: { observedGeneration?: unknown };
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads what the controller reports besides itself (spec 7.7), from the namespace's objects, with two lists:
 *
 * - **Per provider:** its Deployment's ready replicas (none while the Deployment's status is older than its spec, or when
 * it isn't there), the image it runs and when it last rolled out: the `Progressing` condition's last update, but only
 * once the rollout completed (status `True`, reason `NewReplicaSetAvailable`). While one is under way the Deployment
 * controller moves that time on, and a failed one (`ProgressDeadlineExceeded`) sets it too, so neither is reported.
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

    constructor(private readonly options: StatusCollectorOptions) {
        this.ledger = options.ledger ?? new OperationLedger();
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
        return state.providers.map((provider) => {
            const deployment: ListedDeployment | undefined = byName.get(deploymentName(settings, provider.uid));
            const entry: ProviderStatusV1 = { providerUid: provider.uid, readyReplicas: this.readyReplicas(deployment) };
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
    }

    /** The ready replicas the Deployment's status says, unless that status is of an older spec than the Deployment's now. */
    private readyReplicas(deployment: ListedDeployment | undefined): number {
        const status: ListedDeployment["status"] = deployment?.status;
        const stale: boolean = (status?.observedGeneration ?? 0) < (deployment?.metadata?.generation ?? 0);
        return !stale && isCount(status?.readyReplicas) ? status.readyReplicas : 0;
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
