///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { HandshakeOutcome, ServerClient } from "./api/ServerClient.js";
import type { DesiredStateSync } from "./DesiredStateSync.js";
import type { HealthStatus } from "./HealthServer.js";
import type { LeaseElector } from "./kube/LeaseElector.js";
import type { Logger } from "./log.js";

export type ControllerState = "starting" | "unavailable" | "incompatible" | "compatible" | "stopped";

export interface ControllerOptions {
    server: Pick<ServerClient, "handshake">;
    elector: Pick<LeaseElector, "start" | "stop" | "holds">;
    log: Logger;
    controllerVersion: string;
    /** Wait after an incompatible answer before asking again (a rolling upgrade of the other side may fix it). */
    handshakeRetrySeconds: number;
    /** Backoff while the server cannot be reached: doubles from `initial` up to `max`. */
    backoffInitialMs?: number;
    backoffMaxMs?: number;
    /** Reads the desired state and reports status while compatible. */
    sync?: Pick<DesiredStateSync, "start" | "stop" | "health">;
}

/**
 * The controller's top level: the compatibility handshake, then the Lease and the desired-state sync. Reconciling
 * desired state into Kubernetes objects (phase C3) starts only when both hold.
 *
 * - **Compatible:** the Lease elector and the desired-state sync start; nothing is written without holding the Lease.
 * - **Incompatible:** the controller refuses to act. It does not take (and releases) the Lease, stops the sync, writes
 * nothing, reports not ready, logs `dns_api_incompatible`, and asks again every `handshakeRetrySeconds`.
 * - **Unavailable** (the server cannot be reached or answered with an error): not a mismatch. The controller stays ready
 * and retries with backoff.
 * - **A later call finds the server no longer speaks the version** (rolled back underneath the controller): the sync
 * stops, the controller stops writing and goes back to the handshake (`recheck`), at once the first time and then at
 * most once every `handshakeRetrySeconds`, so a server that keeps saying "compatible" without serving v1 cannot make it
 * spin.
 */
export class Controller {
    private state: ControllerState = "starting";
    private last?: HandshakeOutcome;
    private timer?: NodeJS.Timeout;
    private lastRecheckAt?: number;
    private backoffMs: number;
    private readonly backoffInitialMs: number;
    private readonly backoffMaxMs: number;

    constructor(private readonly options: ControllerOptions) {
        this.backoffInitialMs = options.backoffInitialMs ?? 1000;
        this.backoffMaxMs = options.backoffMaxMs ?? 30000;
        this.backoffMs = this.backoffInitialMs;
    }

    get currentState(): ControllerState {
        return this.state;
    }

    /** Whether the controller may write to Kubernetes right now: compatible and holding the Lease. */
    mayWrite(): boolean {
        return this.state === "compatible" && this.options.elector.holds();
    }

    start(): void {
        void this.attempt();
    }

    /** One handshake and its consequences; schedules the next attempt when one is needed. */
    async attempt(): Promise<void> {
        if (this.state === "stopped") {
            return;
        }
        const outcome: HandshakeOutcome = await this.options.server.handshake();
        // stop() may have run while the handshake was in flight.
        if ((this.state as ControllerState) === "stopped") {
            return;
        }
        this.last = outcome;
        const { log } = this.options;
        switch (outcome.state) {
            case "compatible":
                this.backoffMs = this.backoffInitialMs;
                if (this.state !== "compatible") {
                    log.info("dns_api_compatible", { apiVersion: outcome.apiVersion, serverVersion: outcome.serverVersion });
                    this.state = "compatible";
                    this.options.elector.start();
                    this.options.sync?.start((reason) => this.recheck(reason));
                }
                return;
            case "incompatible":
                this.backoffMs = this.backoffInitialMs;
                log.error("dns_api_incompatible", {
                    reason: outcome.reason,
                    controllerVersion: this.options.controllerVersion,
                    serverVersion: outcome.serverVersion,
                    serverApiVersions: outcome.serverApiVersions,
                });
                this.state = "incompatible";
                this.options.sync?.stop();
                await this.options.elector.stop();
                this.schedule(this.options.handshakeRetrySeconds * 1000);
                return;
            default:
                log.warn("dns_api_unavailable", { error: outcome.error, retryInMs: this.backoffMs });
                if (this.state === "starting") {
                    this.state = "unavailable";
                }
                this.schedule(this.backoffMs);
                this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMaxMs);
        }
    }

    private schedule(ms: number): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.attempt(), ms);
    }

    /**
     * A call made after the handshake found that the server no longer speaks the agreed version: stop writing and
     * syncing, and handshake again. The Lease is kept meanwhile (releasing it for what is usually a server restart would
     * only churn); the handshake's answer decides.
     */
    recheck(reason: string): void {
        if (this.state !== "compatible") {
            return;
        }
        this.options.log.warn("dns_api_recheck", { reason });
        this.state = "starting";
        this.options.sync?.stop();
        const retryMs: number = this.options.handshakeRetrySeconds * 1000;
        const now: number = Date.now();
        const at: number = this.lastRecheckAt === undefined ? now : Math.max(now, this.lastRecheckAt + retryMs);
        this.lastRecheckAt = at;
        this.schedule(at - now);
    }

    /** What `/readyz` reports: not ready only while refusing to act because of an API mismatch. */
    health(): HealthStatus {
        const details: Record<string, unknown> = {
            state: this.state,
            controllerVersion: this.options.controllerVersion,
            leaseHolder: this.options.elector.holds(),
        };
        if (this.last?.state === "compatible") {
            details.apiVersion = this.last.apiVersion;
            details.serverVersion = this.last.serverVersion;
        } else if (this.last?.state === "incompatible") {
            details.reason = this.last.reason;
            details.serverVersion = this.last.serverVersion;
        } else if (this.last?.state === "unavailable") {
            details.lastError = this.last.error;
        }
        if (this.state === "compatible") {
            Object.assign(details, this.options.sync?.health());
        }
        return { ready: this.state !== "incompatible" && this.state !== "stopped", details };
    }

    /** Stops retrying and syncing, and releases the Lease. */
    async stop(): Promise<void> {
        this.state = "stopped";
        clearTimeout(this.timer);
        this.options.sync?.stop();
        await this.options.elector.stop();
    }
}
