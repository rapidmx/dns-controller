import { readFileSync } from "node:fs";
import {
    API_VERSION_V1,
    ApiVersionError,
    expectV1,
    SUPPORTED_API_VERSIONS,
    versionPath,
    type DesiredStateV1,
    type StatusReportV1,
} from "../../src/api/v1.js";

/** The contract fixtures, shared with @rapidmx/restapi's copy of these types. */
export function fixture(name: string): unknown {
    return JSON.parse(readFileSync(new URL(`../fixtures/api/v1/${name}.json`, import.meta.url), "utf8"));
}

describe("API v1", () => {
    it("speaks exactly dns.rapidmx.io/v1, served under /v1", () => {
        expect(API_VERSION_V1).toBe("dns.rapidmx.io/v1");
        expect(SUPPORTED_API_VERSIONS).toEqual(["dns.rapidmx.io/v1"]);
        expect(versionPath(API_VERSION_V1)).toBe("/v1");
        expect(versionPath("dns.rapidmx.io/v2")).toBe("/v2");
    });

    it("accepts the desired-state fixture, ignoring fields it does not know", () => {
        const state = expectV1<DesiredStateV1>(fixture("desired-state"), "DesiredState");
        expect(state.version).toBe(42);
        expect(state.endpointSets[0].records.map((r) => r.dnsName)).toContain("_rapidmx-verify.example.com");
        // An option value may be a list.
        expect(state.providers[0].options.zoneIds).toEqual(["0123456789abcdef0123456789abcdef"]);
    });

    it("accepts the status-report fixture", () => {
        expect(expectV1<StatusReportV1>(fixture("status-report"), "StatusReport").lease.holder).toBe(true);
    });

    it("refuses another apiVersion, naming what it received", () => {
        const v2 = { ...(fixture("desired-state") as object), apiVersion: "dns.rapidmx.io/v2" };
        let err: unknown;
        try {
            expectV1(v2, "DesiredState");
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(ApiVersionError);
        expect(err).toMatchObject({
            received: "dns.rapidmx.io/v2",
            message: 'unsupported apiVersion "dns.rapidmx.io/v2"; this controller speaks dns.rapidmx.io/v1',
        });
    });

    it("refuses a payload without an apiVersion, of another kind, or not an object", () => {
        expect(() => expectV1({ kind: "DesiredState" }, "DesiredState")).toThrow("unsupported apiVersion undefined");
        expect(() => expectV1(fixture("status-report"), "DesiredState")).toThrow('expected kind DesiredState, got "StatusReport"');
        expect(() => expectV1(null, "DesiredState")).toThrow("expected a DesiredState object");
        expect(() => expectV1("x", "DesiredState")).toThrow(ApiVersionError);
    });
});
