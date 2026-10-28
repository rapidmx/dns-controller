///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { CallOutcome, ServerClient } from "./api/ServerClient.js";
import { API_VERSION_V1, type DesiredStateV1, type StatusReportResultV1, type StatusReportV1 } from "./api/v1.js";
import type { LeaseElector } from "./kube/LeaseElector.js";
import type { Logger } from "./log.js";
import type { StatusEntries } from "./reconcile/StatusCollector.js";

const NO_ENTRIES: StatusEntries = { providers: [], endpoints: [], operations: [] };

export interface DesiredStateSyncOptions {
    server: Pick<ServerClient, "desiredState" | "reportStatus">;
    /** What the reports say about the Lease: the server acts only on the holder's (7.3). */
    lease: Pick<LeaseElector, "holds">;
    log: Logger;
    controllerVersion: string;
    /** This pod's identity in the Lease. */
    identity: string;
    /** How often to report while nothing changes. */
    statusIntervalSeconds: number;
    /** Called with each new desired state (phase C3 reconciles it). What it throws is logged; the sync goes on. */
    onDesiredState?: (state: DesiredStateV1) => void;
    /** The provider, endpoint and operation entries of a report, read for the desired state the controller has; asked only of the Lease holder. If it throws, the report goes out without entries (`status_entries_failed`). */
    entries?: (state: DesiredStateV1) => Promise<StatusEntries>;
    /** Backoff while the server cannot be reached or answers with something malformed: doubles from `initial` to `max`. */
    backoffInitialMs?: number;
    backoffMaxMs?: number;
    /** The least time between the starts of two requests, so a server answering at once cannot make the poll spin. */
    minPollIntervalMs?: number;
}

/**
 * Keeps the controller's copy of the server's desired state current and reports back (spec 7.3):
 *
 * - **Long poll.** The first request of a run asks for the whole state; every later one passes the version it has as
 * `since`, which the server holds until the version moves or its long poll ends. **Any** other version is a change, a
 * lower one included: the server's counter can be reset (Redis restarted without persistence), and it then answers at
 * once with its new count.
 * - **Status reports** go out after every change (so the server learns which version this pod has) and every
 * `statusIntervalSeconds`, never two at once. Each says whether this pod holds the Lease; the server acts only on the
 * holder's.
 * - A call that finds the server no longer speaks v1 stops the sync and hands the reason to the controller, which goes
 * back to the handshake. Anything else (no answer, a malformed state) keeps the last good state and retries with
 * backoff: a malformed state is never acted on.
 */
export class DesiredStateSync {
    private readonly backoffInitialMs: number;
    private readonly backoffMaxMs: number;
    private readonly minPollIntervalMs: number;
    private current?: DesiredStateV1;
    private lastError?: string;
    private run = 0;
    private running = false;
    private abort?: AbortController;
    private statusTimer?: NodeJS.Timeout;
    private onIncompatible!: (reason: string) => void;
    private reporting = false;
    private reportAgain = false;

    constructor(private readonly options: DesiredStateSyncOptions) {
        this.backoffInitialMs = options.backoffInitialMs ?? 1000;
        this.backoffMaxMs = options.backoffMaxMs ?? 30000;
        this.minPollIntervalMs = options.minPollIntervalMs ?? 1000;
    }

    /** The last desired state read, kept across restarts until a new one arrives. */
    get desiredState(): DesiredStateV1 | undefined {
        return this.current;
    }

    /** Starts polling and reporting; `onIncompatible` is called (once) when the server no longer speaks v1. */
    start(onIncompatible: (reason: string) => void): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.onIncompatible = onIncompatible;
        this.abort = new AbortController();
        const run: number = ++this.run;
        void this.poll(run, this.abort.signal);
        this.scheduleReport(run);
    }

    /** Stops polling and reporting, ending a long poll in flight. */
    stop(): void {
        this.running = false;
        this.abort?.abort(new Error("the DNS controller is stopping"));
        clearTimeout(this.statusTimer);
    }

    /** What `/readyz` shows of the sync. */
    health(): Record<string, unknown> {
        const details: Record<string, unknown> = {};
        if (this.current) {
            details.desiredStateVersion = this.current.version;
        }
        if (this.lastError !== undefined) {
            details.syncError = this.lastError;
        }
        return details;
    }

    private isCurrent(run: number): boolean {
        return this.running && run === this.run;
    }

    /** Waits `ms`, or less when `signal` aborts. */
    private sleep(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const onAbort = (): void => {
                clearTimeout(timer);
                resolve();
            };
            // The listener goes with the wait: a signal lives as long as a run, which may poll for months.
            const timer: NodeJS.Timeout = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    /** Stops and hands `reason` to the controller. Its callers check that the sync still runs, so it is called once. */
    private incompatible(reason: string): void {
        this.stop();
        this.onIncompatible(reason);
    }

    private async poll(run: number, signal: AbortSignal): Promise<void> {
        let since: number | undefined;
        let backoffMs: number = this.backoffInitialMs;
        const { log } = this.options;
        while (this.isCurrent(run)) {
            const startedAt: number = Date.now();
            const outcome: CallOutcome<DesiredStateV1> = await this.options.server.desiredState(since, signal);
            if (!this.isCurrent(run)) {
                return;
            }
            if (outcome.state === "incompatible") {
                this.incompatible(outcome.reason);
                return;
            }
            if (outcome.state !== "ok") {
                this.lastError = outcome.error;
                const invalid: boolean = outcome.state === "invalid";
                log[invalid ? "error" : "warn"](invalid ? "desired_state_invalid" : "desired_state_unavailable", {
                    error: outcome.error,
                    retryInMs: backoffMs,
                });
                await this.sleep(backoffMs, signal);
                backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs);
                continue;
            }
            backoffMs = this.backoffInitialMs;
            this.lastError = undefined;
            const state: DesiredStateV1 = outcome.value;
            if (since === undefined || state.version !== since) {
                this.current = state;
                log.info("desired_state_received", {
                    version: state.version,
                    providers: state.providers.length,
                    endpointSets: state.endpointSets.length,
                    operations: state.operations.length,
                });
                try {
                    this.options.onDesiredState?.(state);
                } catch (err) {
                    // The poll runs detached: an exception out of it would be an unhandled rejection, which ends the process.
                    log.error("desired_state_apply_failed", { version: state.version, error: err });
                }
                void this.report();
            }
            since = state.version;
            await this.sleep(Math.max(0, startedAt + this.minPollIntervalMs - Date.now()), signal);
        }
    }

    /** The periodic report of `run`; a report still on its way when the sync restarts does not start a second chain. */
    private scheduleReport(run: number): void {
        this.statusTimer = setTimeout(() => {
            void this.report().then(() => {
                if (this.isCurrent(run)) {
                    this.scheduleReport(run);
                }
            });
        }, this.options.statusIntervalSeconds * 1000);
    }

    /** The entries of a report for `state`, or none (and a warning) when reading them fails: a rejection here would end the process, since the reports run detached. */
    private async entries(state: DesiredStateV1): Promise<StatusEntries> {
        try {
            return (await this.options.entries?.(state)) ?? NO_ENTRIES;
        } catch (err) {
            this.options.log.warn("status_entries_failed", { error: err });
            return NO_ENTRIES;
        }
    }

    /**
     * Sends a status report now. One asked for while another is on its way is sent once that one is answered, with
     * what is current then. A report says what the controller is (its version, the desired-state version it has, its
     * Lease); that of the Lease holder also carries the providers', endpoints' and operations' entries, which the server
     * would ignore from any other pod, so a pod without the Lease neither reads nor sends them.
     */
    async report(): Promise<void> {
        if (!this.running) {
            return;
        }
        if (this.reporting) {
            this.reportAgain = true;
            return;
        }
        this.reporting = true;
        try {
            do {
                this.reportAgain = false;
                const holder: boolean = this.options.lease.holds();
                // The state the entries are read for is the version the report names, even if a newer one arrives meanwhile
                // (the report sent right after it corrects the server).
                const state: DesiredStateV1 | undefined = this.current;
                const entries: StatusEntries = holder && state ? await this.entries(state) : NO_ENTRIES;
                const report: StatusReportV1 = {
                    apiVersion: API_VERSION_V1,
                    kind: "StatusReport",
                    controllerVersion: this.options.controllerVersion,
                    ...(state ? { desiredStateVersion: state.version } : {}),
                    lease: { holder, identity: this.options.identity },
                    ...entries,
                };
                const outcome: CallOutcome<StatusReportResultV1> = await this.options.server.reportStatus(report);
                if (!this.running) {
                    return;
                }
                if (outcome.state === "incompatible") {
                    this.incompatible(outcome.reason);
                    return;
                }
                if (outcome.state !== "ok") {
                    this.options.log.warn("status_report_failed", { error: outcome.error });
                }
            } while (this.reportAgain);
        } finally {
            this.reporting = false;
        }
    }
}
