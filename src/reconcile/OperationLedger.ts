///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { OperationStatusV1 } from "../api/v1.js";

/** What the controller has to report of one operation: its state and, when it has one, why. */
export type OperationResult = Omit<OperationStatusV1, "id">;

/**
 * The results of the operations the controller runs (the test, takeover and restore Jobs of phase C4), by operation id,
 * for the status report. In memory only: the server lists an operation in the desired state until it is finished, so a
 * restart loses nothing it needs. `retain()` drops a result once the server stops listing its operation; it is called as
 * a desired state *arrives* (never from a report, which may be for an older one and would drop a result recorded for an
 * operation only the newer lists), and `clear()` when the Lease is lost.
 */
export class OperationLedger {
    private readonly results: Map<string, OperationResult> = new Map();

    /** Records `state` as the latest result of operation `id`, replacing an earlier one. */
    record(id: string, state: OperationResult["state"], message?: string): void {
        this.results.set(id, { state, ...(message !== undefined ? { message } : {}) });
    }

    get(id: string): OperationResult | undefined {
        return this.results.get(id);
    }

    /** Forgets every result: the controller no longer holds the Lease, so what it recorded is no longer its to report. */
    clear(): void {
        this.results.clear();
    }

    /** Forgets every result but those of the operations in `ids`. */
    retain(ids: Iterable<string>): void {
        const keep: Set<string> = new Set(ids);
        for (const id of [...this.results.keys()]) {
            if (!keep.has(id)) {
                this.results.delete(id);
            }
        }
    }
}
