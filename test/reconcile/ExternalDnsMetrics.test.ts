import { readFileSync } from "node:fs";
import { parseExternalDnsMetrics } from "../../src/reconcile/ExternalDnsMetrics.js";

/**
 * The pages are recorded from the real `registry.k8s.io/external-dns/external-dns:v0.23.0` image (digest
 * sha256:1854499e...) running `--registry=txt --policy=sync --provider=webhook`, against a stand-in Kubernetes API and
 * webhook provider: `metrics-synced.txt` after several successful syncs, `metrics-provider-failing.txt` while the provider's
 * list of records answered 500 (a soft error: the process keeps running and retries). They are the unedited `/metrics`
 * answers, the Go runtime's included.
 */
const page = (name: string): string => readFileSync(new URL(`../fixtures/external-dns/v0.23.0/${name}`, import.meta.url), "utf8");

/** What a sample of a metric looks like in the text format, for the cases the recorded pages can't produce. */
const SYNCED_AT = "external_dns_controller_last_sync_timestamp_seconds";

describe("parseExternalDnsMetrics", () => {
    it("reads the last successful sync and the error counts from a recorded v0.23.0 page of a working instance", () => {
        // 1.7931521286068296e+09 seconds, as the Go client prints a float64 gauge.
        expect(parseExternalDnsMetrics(page("metrics-synced.txt"))).toEqual({
            lastSyncAt: "2026-10-28T01:48:48.607Z",
            registryErrors: 0,
            sourceErrors: 0,
            providerErrors: 0,
        });
    });

    it("reports no sync time while the instance has never synced, and its errors, from a recorded page of a failing provider", () => {
        // The time gauge is 0 until the first successful sync; the provider's failures count as registry errors and as consecutive soft errors.
        expect(parseExternalDnsMetrics(page("metrics-provider-failing.txt"))).toEqual({
            registryErrors: 4,
            sourceErrors: 0,
            providerErrors: 4,
        });
    });

    it("reports the records skipped for an owner mismatch, summed over the series of the metric", () => {
        // The name and its labels are those of v0.23.0 (`foreign_owner` and `record_type` are in its binary); this series is written by hand,
        // since none of the scenarios tried made the real instance emit one.
        const text = [
            page("metrics-synced.txt"),
            "# HELP external_dns_registry_skipped_records_owner_mismatch_per_sync Number of records skipped with owner mismatch for each record type, owner mismatch ID and domain (vector).",
            "# TYPE external_dns_registry_skipped_records_owner_mismatch_per_sync gauge",
            'external_dns_registry_skipped_records_owner_mismatch_per_sync{domain="example.com",foreign_owner="someone-else",owner="rapidmx",record_type="a"} 2',
            'external_dns_registry_skipped_records_owner_mismatch_per_sync{domain="example.org",foreign_owner="",owner="rapidmx",record_type="txt"} 1',
        ].join("\n");
        expect(parseExternalDnsMetrics(text)?.ownerMismatchRecords).toBe(3);
    });

    it("leaves out the owner mismatches while the page has none of that metric: external-dns omits a vector without series", () => {
        expect(parseExternalDnsMetrics(page("metrics-synced.txt"))).not.toHaveProperty("ownerMismatchRecords");
    });

    it("leaves out whatever the page doesn't say instead of reporting it as zero", () => {
        expect(parseExternalDnsMetrics("external_dns_build_info{version=\"v0.23.0\"} 1\n")).toEqual({});
        expect(parseExternalDnsMetrics("external_dns_source_errors_total 7\n")).toEqual({ sourceErrors: 7 });
    });

    it("is not fooled by a page that is not external-dns's", () => {
        expect(parseExternalDnsMetrics("")).toBeUndefined();
        expect(parseExternalDnsMetrics("go_goroutines 12\nprocess_open_fds 9\n")).toBeUndefined();
        expect(parseExternalDnsMetrics('{"status":"ok"}')).toBeUndefined();
        expect(parseExternalDnsMetrics("<html>external_dns_registry_errors_total 1</html>")).toBeUndefined();
    });

    it("keeps the counts of a name's own series only, not those of a metric that merely starts the same", () => {
        const text = ["external_dns_source_errors_total_bogus 5", "external_dns_source_errors 6", "external_dns_source_errors_total 1"].join("\n");
        expect(parseExternalDnsMetrics(text)).toEqual({ sourceErrors: 1 });
    });

    it("reads a sample with a timestamp, CRLF line ends, or tabs between its parts", () => {
        const text = ["external_dns_registry_errors_total 3 1793152128000\r", "external_dns_source_errors_total\t2\r", `${SYNCED_AT} 1.7931521286e+09\r`].join("\n");
        expect(parseExternalDnsMetrics(text)).toEqual({ registryErrors: 3, sourceErrors: 2, lastSyncAt: "2026-10-28T01:48:48.600Z" });
    });

    it("reads past labels whose values hold braces, spaces, quotes and escaped quotes", () => {
        const text = [
            'external_dns_registry_skipped_records_owner_mismatch_per_sync{domain="a} 99 b",foreign_owner="x\\"} 77",owner="r",record_type="a"} 4',
            'external_dns_source_errors_total{note="a\\\\"} 5',
        ].join("\n");
        expect(parseExternalDnsMetrics(text)).toEqual({ ownerMismatchRecords: 4, sourceErrors: 5 });
    });

    it("rounds a counter that the client printed as a float, and ignores one that is negative, not a number or infinite", () => {
        expect(parseExternalDnsMetrics("external_dns_registry_errors_total 2.0000001e+00")).toEqual({ registryErrors: 2 });
        expect(parseExternalDnsMetrics("external_dns_registry_errors_total -1\nexternal_dns_source_errors_total NaN\nexternal_dns_controller_consecutive_soft_errors +Inf")).toEqual({});
        expect(parseExternalDnsMetrics("external_dns_registry_errors_total 1e300\nexternal_dns_source_errors_total abc")).toEqual({});
    });

    it("leaves out a sync time that is zero (never), negative or no date", () => {
        for (const value of ["0", "-5", "1e30", "NaN"]) {
            expect(parseExternalDnsMetrics(`external_dns_build_info 1\n${SYNCED_AT} ${value}`)).toEqual({});
        }
    });

    it("skips lines that are not samples, whatever they hold", () => {
        const text = [
            "# TYPE external_dns_source_errors_total counter",
            "",
            "   ",
            "external_dns_source_errors_total",
            'external_dns_source_errors_total{unterminated="x 9',
            "external_dns_source_errors_total{a=\"b\"}",
            "external_dns_source_errors_total,2 8",
            "external_dns_registry_errors_total 5",
        ].join("\n");
        expect(parseExternalDnsMetrics(text)).toEqual({ registryErrors: 5 });
    });

    it("takes the latest of several sync times, such as one per series", () => {
        const text = `${SYNCED_AT}{a="1"} 1.7931521e+09\n${SYNCED_AT}{a="2"} 1.7931522e+09\nexternal_dns_build_info 1`;
        expect(parseExternalDnsMetrics(text)).toEqual({ lastSyncAt: "2026-10-28T01:50:00.000Z" });
    });
});
