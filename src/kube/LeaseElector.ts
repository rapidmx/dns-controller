///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Logger } from "../log.js";
import { isKubeStatus, type KubeClient } from "./KubeClient.js";

/** The parts of a `coordination.k8s.io/v1` Lease the controller reads and writes. */
export interface Lease {
    apiVersion: "coordination.k8s.io/v1";
    kind: "Lease";
    metadata: { name: string; namespace: string; resourceVersion?: string; labels?: Record<string, string> };
    spec: {
        holderIdentity?: string;
        leaseDurationSeconds?: number;
        acquireTime?: string;
        renewTime?: string;
        leaseTransitions?: number;
    };
}

export interface LeaseElectorOptions {
    kube: KubeClient;
    namespace: string;
    name: string;
    identity: string;
    leaseDurationSeconds: number;
    renewIntervalSeconds: number;
    log: Logger;
    /** Called once each time this process becomes the holder. */
    onAcquired?: () => void;
    /** Called once each time this process stops being the holder (lost, expired locally, or released). */
    onLost?: () => void;
    /** Milliseconds since the epoch. Replaceable for tests. */
    now?: () => number;
}

/** A Kubernetes `MicroTime`: RFC 3339 with microseconds, which the API server requires for Lease times. */
export function microTime(ms: number): string {
    return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/**
 * Single-writer election over a Lease, the way client-go's leader election works:
 *
 * - Another holder's Lease is treated as expired only when this process has seen the **same record** (holder and
 * renew time) unchanged for a whole lease duration, measured on this process's own clock. Comparing the record's
 * `renewTime` with the local clock would let clock skew between nodes produce two holders.
 * - Every write carries the `resourceVersion` it read, so two candidates racing for an expired Lease cannot both win:
 * the loser gets 409 Conflict.
 * - The holder considers itself the writer only while its last successful renewal is younger than two thirds of the
 * duration (`holds()`), so it stops writing before anyone else could take the Lease over.
 */
export class LeaseElector {
    private readonly now: () => number;
    private readonly path: string;
    private observedRecord?: string;
    private observedAt = 0;
    private lastRenewedAt?: number;
    private leading = false;
    private timer?: NodeJS.Timeout;
    private running = false;

    constructor(private readonly options: LeaseElectorOptions) {
        this.now = options.now ?? Date.now;
        this.path = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(options.namespace)}/leases`;
    }

    /** Whether this process may write now. Check it immediately before every write. */
    holds(): boolean {
        if (!this.leading || this.lastRenewedAt === undefined) {
            return false;
        }
        return this.now() - this.lastRenewedAt < (this.options.leaseDurationSeconds * 1000 * 2) / 3;
    }

    /** One attempt to acquire or renew the Lease. Returns whether this process holds it afterwards. Never throws. */
    async tryAcquireOrRenew(): Promise<boolean> {
        const { kube, name, identity, leaseDurationSeconds, log } = this.options;
        const now: number = this.now();
        let current: Lease | undefined;
        try {
            current = await kube.get<Lease>(`${this.path}/${encodeURIComponent(name)}`);
        } catch (err) {
            if (!isKubeStatus(err, 404)) {
                log.warn("lease_read_failed", { lease: name, error: err });
                return this.settle();
            }
        }

        if (!current) {
            try {
                await kube.create<Lease>(this.path, this.desired(undefined, now));
                return this.settle(now);
            } catch (err) {
                // 409: another candidate created it first.
                log[isKubeStatus(err, 409) ? "debug" : "warn"]("lease_create_failed", { lease: name, error: err });
                return this.settle();
            }
        }

        const holder: string = current.spec.holderIdentity ?? "";
        const record = `${holder}|${current.spec.renewTime ?? ""}|${current.metadata.resourceVersion ?? ""}`;
        if (record !== this.observedRecord) {
            this.observedRecord = record;
            this.observedAt = now;
        }
        const duration: number = (current.spec.leaseDurationSeconds ?? leaseDurationSeconds) * 1000;
        if (holder !== "" && holder !== identity && this.observedAt + duration > now) {
            // Someone else holds it: stop writing at once, whatever the last own renewal was.
            return this.settle(undefined, true);
        }

        try {
            await kube.replace<Lease>(`${this.path}/${encodeURIComponent(name)}`, this.desired(current, now));
            return this.settle(now);
        } catch (err) {
            // 409: the Lease changed since it was read, so someone else wrote it: stop writing until the next read.
            const conflict: boolean = isKubeStatus(err, 409);
            log[conflict ? "debug" : "warn"]("lease_update_failed", { lease: name, error: err });
            return this.settle(undefined, conflict);
        }
    }

    /** Starts trying to acquire, then renewing, every renew interval until `stop()`. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        const tick = async (): Promise<void> => {
            await this.tryAcquireOrRenew();
            if (this.running) {
                this.timer = setTimeout(() => void tick(), this.options.renewIntervalSeconds * 1000);
            }
        };
        void tick();
    }

    /**
     * Stops the loop and, when this process holds the Lease, releases it (empty holder, as client-go does), so a
     * successor does not have to wait a whole duration. Never throws.
     */
    async stop(): Promise<void> {
        this.running = false;
        clearTimeout(this.timer);
        if (!this.leading) {
            return;
        }
        this.leading = false;
        this.options.onLost?.();
        const { kube, name, identity, log } = this.options;
        try {
            const current: Lease = await kube.get<Lease>(`${this.path}/${encodeURIComponent(name)}`);
            if (current.spec.holderIdentity !== identity) {
                return;
            }
            await kube.replace<Lease>(`${this.path}/${encodeURIComponent(name)}`, {
                ...current,
                spec: { ...current.spec, holderIdentity: "", leaseDurationSeconds: 1, renewTime: microTime(this.now()) },
            });
            log.info("lease_released", { lease: name });
        } catch (err) {
            log.warn("lease_release_failed", { lease: name, error: err });
        }
    }

    /** The Lease as this process wants it: created, renewed, or taken over from an expired holder. */
    private desired(current: Lease | undefined, now: number): Lease {
        const { namespace, name, identity, leaseDurationSeconds } = this.options;
        const renewing: boolean = current?.spec.holderIdentity === identity;
        const transitions: number = current?.spec.leaseTransitions ?? 0;
        return {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: current
                ? { ...current.metadata }
                : { name, namespace, labels: { "app.kubernetes.io/managed-by": "rapidmx-dns-controller" } },
            spec: {
                holderIdentity: identity,
                leaseDurationSeconds,
                acquireTime: renewing ? current?.spec.acquireTime : microTime(now),
                renewTime: microTime(now),
                leaseTransitions: current && !renewing ? transitions + 1 : transitions,
            },
        };
    }

    /**
     * Records the outcome of an attempt (`renewedAt` set on success; `lost` when another writer is known to have the
     * Lease) and fires the transition callbacks. A failed renewal alone keeps the holder writing while `holds()` allows.
     */
    private settle(renewedAt?: number, lost = false): boolean {
        if (renewedAt !== undefined) {
            this.lastRenewedAt = renewedAt;
        } else if (lost) {
            this.lastRenewedAt = undefined;
        }
        const nowHolds: boolean = renewedAt !== undefined || this.holds();
        if (nowHolds && !this.leading) {
            this.leading = true;
            this.options.log.info("lease_acquired", { lease: this.options.name, identity: this.options.identity });
            this.options.onAcquired?.();
        } else if (!nowHolds && this.leading) {
            this.leading = false;
            this.options.log.warn("lease_lost", { lease: this.options.name, identity: this.options.identity });
            this.options.onLost?.();
        }
        return nowHolds;
    }
}
