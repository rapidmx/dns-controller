///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { HandshakeOutcome, ServerClient } from "./api/ServerClient.js";
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
}

/**
 * The controller's top level. Phase C1: the compatibility handshake, then the Lease. Reconciling desired state into
 * Kubernetes objects (phase C3) starts only when both hold.
 *
 * - **Compatible:** the Lease elector starts; nothing is written without holding it.
 * - **Incompatible:** the controller refuses to act. It does not take (and releases) the Lease, writes nothing, reports
 * not ready, logs `dns_api_incompatible`, and asks again every `handshakeRetrySeconds`.
 * - **Unavailable** (the server cannot be reached or answered with an error): not a mismatch. The controller stays ready
 * and retries with backoff.
 */
export class Controller {
    private state: ControllerState = "starting";
    private last?: HandshakeOutcome;
    private timer?: NodeJS.Timeout;
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
        return { ready: this.state !== "incompatible" && this.state !== "stopped", details };
    }

    /** Stops retrying and releases the Lease. */
    async stop(): Promise<void> {
        this.state = "stopped";
        clearTimeout(this.timer);
        await this.options.elector.stop();
    }
}
