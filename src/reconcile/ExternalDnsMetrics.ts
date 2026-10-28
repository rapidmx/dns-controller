///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The metrics of external-dns v0.23.0 a provider's health is read from (checked against a recorded page and the binary). */
export const METRIC_LAST_SYNC = "external_dns_controller_last_sync_timestamp_seconds";
export const METRIC_REGISTRY_ERRORS = "external_dns_registry_errors_total";
export const METRIC_SOURCE_ERRORS = "external_dns_source_errors_total";
export const METRIC_SOFT_ERRORS = "external_dns_controller_consecutive_soft_errors";
export const METRIC_OWNER_MISMATCH = "external_dns_registry_skipped_records_owner_mismatch_per_sync";

/** What a provider's status report carries from its instance's `/metrics`; a field the page doesn't have is left out. */
export interface ExternalDnsMetrics {
    /** The last successful sync with the provider, as an ISO 8601 time; absent while the gauge is 0 (never synced). */
    lastSyncAt?: string;
    /** Registry errors since the process started. A provider that can't list or change its records counts here too. */
    registryErrors?: number;
    /** Source errors since the process started. */
    sourceErrors?: number;
    /**
     * Provider errors: the syncs that failed in a row (the gauge `consecutive_soft_errors`). v0.23.0 has no counter of its
     * own for the provider's errors; a failing one is a soft error that is retried (0 again after a good sync), and any
     * other error ends the process, which shows as a restart.
     */
    providerErrors?: number;
    /** The records external-dns skipped in its last sync because another owner's TXT record holds them: conflicts (spec 9). */
    ownerMismatchRecords?: number;
}

const NAME: RegExp = /^[A-Za-z_:][A-Za-z0-9_:]*/;

/**
 * Where the labels that start at `from` (just after the `{`) end: the index of the closing `}`, or -1. A label value is
 * quoted and may hold `}`, spaces and escaped quotes.
 */
function labelsEnd(line: string, from: number): number {
    let quoted = false;
    for (let i = from; i < line.length; i++) {
        const c: string = line[i];
        if (quoted && c === "\\") {
            i++;
        } else if (c === '"') {
            quoted = !quoted;
        } else if (c === "}" && !quoted) {
            return i;
        }
    }
    return -1;
}

/** The (name, value) of a sample line of the text exposition format (NaN when the value is no number), or undefined for anything else. */
function sample(line: string): [string, number] | undefined {
    const name: string | undefined = NAME.exec(line)?.[0];
    if (name === undefined) {
        return undefined;
    }
    let rest: string = line.slice(name.length);
    if (rest.startsWith("{")) {
        const end: number = labelsEnd(rest, 1);
        if (end < 0) {
            return undefined;
        }
        rest = rest.slice(end + 1);
    }
    // The value is the first field after the name and labels (a timestamp may follow it).
    const field: string | undefined = /^[ \t]+(\S+)/.exec(rest)?.[1];
    return field === undefined ? undefined : [name, Number(field)];
}

/** A count as a whole number, when it is one that can be stored. */
function count(values: number[] | undefined): number | undefined {
    if (values === undefined) {
        return undefined;
    }
    const total: number = Math.round(values.reduce((sum, value) => sum + value, 0));
    return Number.isSafeInteger(total) ? total : undefined;
}

/**
 * Reads an external-dns `/metrics` page (Prometheus text format). Returns undefined when the page has no external-dns
 * metric at all, so the answer of some other service on the pod's address isn't taken for health. A sample that isn't
 * a non-negative number is ignored, and the series of one metric (an owner mismatch has one per record type, owner and
 * domain) are summed.
 */
export function parseExternalDnsMetrics(page: string): ExternalDnsMetrics | undefined {
    const wanted: Set<string> = new Set([METRIC_LAST_SYNC, METRIC_REGISTRY_ERRORS, METRIC_SOURCE_ERRORS, METRIC_SOFT_ERRORS, METRIC_OWNER_MISMATCH]);
    const values: Map<string, number[]> = new Map();
    let external = false;
    for (const line of page.split("\n")) {
        const found: [string, number] | undefined = line.startsWith("#") ? undefined : sample(line.trim());
        if (found === undefined) {
            continue;
        }
        external ||= found[0].startsWith("external_dns_");
        if (wanted.has(found[0]) && Number.isFinite(found[1]) && found[1] >= 0) {
            values.set(found[0], [...(values.get(found[0]) ?? []), found[1]]);
        }
    }
    if (!external) {
        return undefined;
    }
    const metrics: ExternalDnsMetrics = {};
    // The gauge is 0 until the first successful sync; with several series the latest counts.
    const synced: Date = new Date(Math.round(Math.max(0, ...(values.get(METRIC_LAST_SYNC) ?? [])) * 1000));
    if (synced.getTime() > 0 && !Number.isNaN(synced.getTime())) {
        metrics.lastSyncAt = synced.toISOString();
    }
    for (const [field, metric] of [
        ["registryErrors", METRIC_REGISTRY_ERRORS],
        ["sourceErrors", METRIC_SOURCE_ERRORS],
        ["providerErrors", METRIC_SOFT_ERRORS],
        ["ownerMismatchRecords", METRIC_OWNER_MISMATCH],
    ] as const) {
        const total: number | undefined = count(values.get(metric));
        if (total !== undefined) {
            metrics[field] = total;
        }
    }
    return metrics;
}
