import { readFileSync } from "node:fs";
import {
    API_VERSION_V1,
    ApiVersionError,
    DnsApiPayloadError,
    expectV1,
    parseDesiredState,
    parseProviderCredentials,
    SUPPORTED_API_VERSIONS,
    versionPath,
    type DesiredStateV1,
    type DnsProviderCredentialsV1,
    type StatusReportResultV1,
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

    it("names the server's answer to a status report", () => {
        const answer = expectV1<StatusReportResultV1>({ apiVersion: API_VERSION_V1, kind: "StatusReportResult" }, "StatusReportResult");
        expect(answer.kind).toBe("StatusReportResult");
    });
});

describe("parseDesiredState", () => {
    /** A copy of the fixture with `patch` applied. */
    function state(patch: (s: any) => unknown = () => undefined): any {
        const s: any = fixture("desired-state");
        patch(s);
        return s;
    }

    it("reads the shared fixture, leaving out the fields v1 does not define", () => {
        const parsed: DesiredStateV1 = parseDesiredState(fixture("desired-state"));
        expect(parsed).toEqual({
            apiVersion: "dns.rapidmx.io/v1",
            kind: "DesiredState",
            version: 42,
            ownerId: "rapidmx-k3x9q2m7a1b4c8d0",
            externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
            providers: [
                {
                    uid: "cloudflare-main",
                    type: "cloudflare",
                    zones: ["example.com"],
                    options: { zoneIds: ["0123456789abcdef0123456789abcdef"] },
                    credentials: { keys: ["apiToken"], generation: 1 },
                    enabled: true,
                },
            ],
            endpointSets: [
                {
                    id: "domain-example-com",
                    providerUid: "cloudflare-main",
                    domainUid: "example.com",
                    records: [
                        { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 },
                        { dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"], ttl: 300 },
                    ],
                },
            ],
            operations: [],
        });
        expect(parsed).not.toHaveProperty("futureField");
    });

    it("reads every optional field: no credentials, the hosts' set, options of every type, operations with and without records", () => {
        const parsed = parseDesiredState(
            state((s) => {
                s.providers.push({
                    uid: "bind",
                    type: "rfc2136",
                    zones: ["example.org"],
                    options: { hosts: ["10.0.0.53"], port: 53, insecure: true, zone: "example.org" },
                    credentials: null,
                    enabled: false,
                    unknown: 1,
                });
                s.endpointSets.push({ id: "hosts-bind", providerUid: "bind", records: [{ dnsName: "mail.example.org", recordType: "A", targets: ["203.0.113.7"] }] });
                s.operations.push(
                    { id: "op-1", type: "test", providerUid: "bind" },
                    {
                        id: "op-2",
                        type: "takeover",
                        providerUid: "cloudflare-main",
                        endpointSetId: "domain-example-com",
                        records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }],
                    }
                );
            })
        );
        expect(parsed.providers[1]).toEqual({
            uid: "bind",
            type: "rfc2136",
            zones: ["example.org"],
            options: { hosts: ["10.0.0.53"], port: 53, insecure: true, zone: "example.org" },
            enabled: false,
        });
        expect(parsed.endpointSets[1]).toEqual({
            id: "hosts-bind",
            providerUid: "bind",
            records: [{ dnsName: "mail.example.org", recordType: "A", targets: ["203.0.113.7"] }],
        });
        expect(parsed.operations).toEqual([
            { id: "op-1", type: "test", providerUid: "bind" },
            {
                id: "op-2",
                type: "takeover",
                providerUid: "cloudflare-main",
                endpointSetId: "domain-example-com",
                records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }],
            },
        ]);
    });

    it("refuses another version or kind as a version mismatch", () => {
        expect(() => parseDesiredState(state((s) => (s.apiVersion = "dns.rapidmx.io/v2")))).toThrow(ApiVersionError);
        expect(() => parseDesiredState(fixture("status-report"))).toThrow(ApiVersionError);
    });

    const options = "must be text, a number, a switch or a list of text";
    it.each([
        ["version", (s: any) => (s.version = -1), "'version' must be a whole number"],
        ["version", (s: any) => (s.version = "42"), "'version' must be a whole number"],
        ["ownerId", (s: any) => (s.ownerId = ""), "'ownerId' must be text"],
        ["externalDnsImage", (s: any) => delete s.externalDnsImage, "'externalDnsImage' must be text"],
        ["providers", (s: any) => (s.providers = {}), "'providers' must be a list"],
        ["providers", (s: any) => (s.providers = [null]), "'providers[0]' must be an object"],
        ["providers", (s: any) => (s.providers[0].uid = 7), "'providers[0].uid' must be text"],
        ["providers", (s: any) => (s.providers[0].type = "digitalocean"), "'providers[0].type' is not a provider type this controller knows"],
        ["providers", (s: any) => (s.providers[0].zones = ["example.com", ""]), "'providers[0].zones' must be a list of text"],
        ["providers", (s: any) => (s.providers[0].zones = "example.com"), "'providers[0].zones' must be a list of text"],
        ["providers", (s: any) => (s.providers[0].options = []), "'providers[0].options' must be an object"],
        ["providers", (s: any) => (s.providers[0].options = null), "'providers[0].options' must be an object"],
        ["providers", (s: any) => (s.providers[0].options = { zoneIds: [1] }), `'providers[0].options.zoneIds' ${options}`],
        ["providers", (s: any) => (s.providers[0].options = { ttl: Infinity }), `'providers[0].options.ttl' ${options}`],
        ["providers", (s: any) => (s.providers[0].options = { nested: {} }), `'providers[0].options.nested' ${options}`],
        ["providers", (s: any) => (s.providers[0].credentials = "dns/x"), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].credentials = []), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => delete s.providers[0].credentials.keys, "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].credentials.keys = [3]), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].credentials.keys = ["apiToken", ""]), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].credentials.generation = 1.5), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].credentials.generation = -1), "'providers[0].credentials' must be the saved credential fields and their generation"],
        ["providers", (s: any) => (s.providers[0].enabled = "true"), "'providers[0].enabled' must be true or false"],
        ["endpointSets", (s: any) => (s.endpointSets = undefined), "'endpointSets' must be a list"],
        ["endpointSets", (s: any) => (s.endpointSets[0].id = ""), "'endpointSets[0].id' must be text"],
        ["endpointSets", (s: any) => (s.endpointSets[0].providerUid = null), "'endpointSets[0].providerUid' must be text"],
        ["endpointSets", (s: any) => (s.endpointSets[0].domainUid = 1), "'endpointSets[0].domainUid' must be text"],
        ["endpointSets", (s: any) => (s.endpointSets[0].records = null), "'endpointSets[0].records' must be a list"],
        ["endpointSets", (s: any) => (s.endpointSets[0].records[1] = "x"), "'endpointSets[0].records[1]' must be an object"],
        ["endpointSets", (s: any) => (s.endpointSets[0].records[0].dnsName = ""), "'endpointSets[0].records[0].dnsName' must be text"],
        [
            "endpointSets",
            (s: any) => (s.endpointSets[0].records[0].recordType = "NS"),
            "'endpointSets[0].records[0].recordType' is not a record type this controller knows",
        ],
        ["endpointSets", (s: any) => (s.endpointSets[0].records[0].targets = []), "'endpointSets[0].records[0].targets' must be a list of text"],
        ["endpointSets", (s: any) => (s.endpointSets[0].records[0].targets = [""]), "'endpointSets[0].records[0].targets' must be a list of text"],
        ["endpointSets", (s: any) => (s.endpointSets[0].records[0].ttl = -5), "'endpointSets[0].records[0].ttl' must be a whole number"],
        ["operations", (s: any) => (s.operations = "none"), "'operations' must be a list"],
        ["operations", (s: any) => s.operations.push({ id: "", type: "test", providerUid: "p" }), "'operations[0].id' must be text"],
        ["operations", (s: any) => s.operations.push({ id: "o", type: "wipe", providerUid: "p" }), "'operations[0].type' is not an operation this controller knows"],
        ["operations", (s: any) => s.operations.push({ id: "o", type: "test" }), "'operations[0].providerUid' must be text"],
        ["operations", (s: any) => s.operations.push({ id: "o", type: "test", providerUid: "p", endpointSetId: 3 }), "'operations[0].endpointSetId' must be text"],
        ["operations", (s: any) => s.operations.push({ id: "o", type: "restore", providerUid: "p", records: {} }), "'operations[0].records' must be a list"],
    ])("refuses the whole state when %s is malformed, naming the field, never a value", (_field, patch, message) => {
        let err: unknown;
        try {
            parseDesiredState(state(patch));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(DnsApiPayloadError);
        expect(err).toMatchObject({ name: "DnsApiPayloadError", message });
    });
});

describe("parseProviderCredentials", () => {
    /** A copy of the fixture with `patch` applied. */
    function answer(patch: (a: any) => unknown = () => undefined, name = "provider-credentials"): any {
        const a: any = fixture(name);
        patch(a);
        return a;
    }

    it("reads the shared fixture, leaving out the fields v1 does not define", () => {
        const parsed: DnsProviderCredentialsV1 = parseProviderCredentials(fixture("provider-credentials"));
        expect(parsed).toEqual({
            apiVersion: "dns.rapidmx.io/v1",
            kind: "DnsProviderCredentials",
            providerUid: "cloudflare-main",
            generation: 1,
            values: { apiToken: "cf-example-token-not-a-real-secret" },
        });
        expect(parsed).not.toHaveProperty("futureField");
        expect(parsed).not.toHaveProperty("unreadable");
    });

    it("reads the fields the server could not decrypt, by name", () => {
        expect(parseProviderCredentials(fixture("provider-credentials-unreadable"))).toEqual({
            apiVersion: "dns.rapidmx.io/v1",
            kind: "DnsProviderCredentials",
            providerUid: "aws-main",
            generation: 2,
            values: { accessKeyId: "AKIAEXAMPLEEXAMPLE00" },
            unreadable: ["secretAccessKey"],
        });
    });

    it("reads a config without credentials: generation 0 and no values", () => {
        expect(parseProviderCredentials(answer((a) => Object.assign(a, { generation: 0, values: {} })))).toMatchObject({ generation: 0, values: {} });
    });

    it("refuses another version or kind as a version mismatch", () => {
        expect(() => parseProviderCredentials(answer((a) => (a.apiVersion = "dns.rapidmx.io/v2")))).toThrow(ApiVersionError);
        expect(() => parseProviderCredentials(fixture("desired-state"))).toThrow(ApiVersionError);
    });

    it.each([
        ["providerUid", (a: any) => (a.providerUid = ""), "'providerUid' must be text"],
        ["generation", (a: any) => (a.generation = "1"), "'generation' must be a whole number"],
        ["generation", (a: any) => (a.generation = -1), "'generation' must be a whole number"],
        ["values", (a: any) => (a.values = []), "'values' must be an object"],
        ["values", (a: any) => delete a.values, "'values' must be an object"],
        ["values", (a: any) => (a.values.apiToken = 5), "'values.apiToken' must be text"],
        ["values", (a: any) => (a.values.apiToken = ""), "'values.apiToken' must be text"],
        ["values", (a: any) => (a.values["bad key/"] = "x"), "'values' has a field name that is not a credential field name"],
        ["unreadable", (a: any) => (a.unreadable = "apiToken"), "'unreadable' must be a list of text"],
        ["unreadable", (a: any) => (a.unreadable = [""]), "'unreadable' must be a list of text"],
    ])("refuses the whole answer when %s is malformed, naming the field, never a value", (_field, patch, message) => {
        let err: unknown;
        try {
            parseProviderCredentials(answer(patch));
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(DnsApiPayloadError);
        expect(err).toMatchObject({ name: "DnsApiPayloadError", message });
        expect((err as Error).message).not.toContain("cf-example-token");
    });
});
