///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Version 1 of the internal DNS API between the RapidMX server and this controller (spec: restapi
// specs/dns_publishing_and_integrations.md, 7.3). Mirrored in @rapidmx/restapi; both repositories test against the same
// JSON fixtures (test/fixtures/api/v1). Rules:
//
// - Every payload, request and response, carries `apiVersion` and `kind`. A payload with another `apiVersion` is
//   refused, never guessed at.
// - Within v1, changes are additive only (new optional fields, kinds or routes); unknown fields are ignored. A breaking
//   change is v2, under /internal/dns/v2.
// - The handshake (`Handshake`/`HandshakeResult`) is unversioned and its shape never changes: it is what lets two
//   mismatched versions find out that they are.
//
// restapi's copy also has the readers of what the controller sends (`negotiateHandshake`, `parseStatusReport`); this one
// has the reader of what the server sends (`parseDesiredState`).

/** The API version this controller speaks. */
export const API_VERSION_V1 = "dns.rapidmx.io/v1";
/** Every API version this controller speaks, best first. */
export const SUPPORTED_API_VERSIONS: readonly string[] = [API_VERSION_V1];

/** The route prefix of a version: `dns.rapidmx.io/v1` is served under `<base>/v1`. */
export function versionPath(apiVersion: string): string {
    return `/${apiVersion.slice(apiVersion.lastIndexOf("/") + 1)}`;
}

// --- Handshake (unversioned, frozen) ---------------------------------------------------------------------------------

/** `POST <base>/handshake`, sent by the controller at start-up and while incompatible. */
export interface Handshake {
    kind: "Handshake";
    controllerVersion: string;
    apiVersions: string[];
}

/** The server's answer. `selected` is the version both sides speak, when there is one. */
export interface HandshakeResult {
    kind: "HandshakeResult";
    serverVersion: string;
    apiVersions: string[];
    compatible: boolean;
    selected?: string;
    reason?: string;
}

// --- v1 payloads -------------------------------------------------------------------------------------------------------

/** Fields every v1 payload has. */
export interface V1Envelope<K extends string> {
    apiVersion: typeof API_VERSION_V1;
    kind: K;
}

export const DNS_PROVIDER_TYPES = ["cloudflare", "route53", "rfc2136", "google", "azure"] as const;
export type DnsProviderType = (typeof DNS_PROVIDER_TYPES)[number];
export const DNS_RECORD_KINDS = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"] as const;
export type DnsRecordKind = (typeof DNS_RECORD_KINDS)[number];
export const OPERATION_TYPES = ["test", "takeover", "restore"] as const;

/** Where a provider's credentials are: a reference, never the value. */
export interface SecretRefV1 {
    backend: "openbao" | "kubernetes";
    path: string;
    keys: string[];
    generation: number;
}

export interface DnsProviderV1 {
    uid: string;
    type: DnsProviderType;
    zones: string[];
    /** Non-secret, type-specific options. A value may be a list (Cloudflare's `zoneIds`, rfc2136's `hosts`). */
    options: Record<string, string | number | boolean | string[]>;
    secretRef?: SecretRefV1;
    enabled: boolean;
}

export interface DnsRecordV1 {
    dnsName: string;
    recordType: DnsRecordKind;
    /** Unquoted values; the controller quotes TXT targets when it writes a `DNSEndpoint`. */
    targets: string[];
    ttl?: number;
}

/** One `DNSEndpoint` worth of records: a domain's, or the deployment hosts' for one provider. */
export interface EndpointSetV1 {
    /** Stable name the controller derives the `DNSEndpoint` name from. */
    id: string;
    providerUid: string;
    domainUid?: string;
    records: DnsRecordV1[];
}

/** A queued operation: a credentials test, a takeover, or restoring kept values of a released set. */
export interface OperationV1 {
    id: string;
    type: (typeof OPERATION_TYPES)[number];
    providerUid: string;
    endpointSetId?: string;
    records?: DnsRecordV1[];
}

/** `GET <base>/v1/desired-state`. */
export interface DesiredStateV1 extends V1Envelope<"DesiredState"> {
    /** Increases on every change; the long poll's `since`. */
    version: number;
    /** The external-dns `--txt-owner-id`. */
    ownerId: string;
    /** The one external-dns image the controller may run. */
    externalDnsImage: string;
    providers: DnsProviderV1[];
    endpointSets: EndpointSetV1[];
    operations: OperationV1[];
}

export interface ProviderStatusV1 {
    providerUid: string;
    readyReplicas: number;
    image?: string;
    lastSyncAt?: string;
    lastError?: string;
}

export interface EndpointStatusV1 {
    endpointSetId: string;
    generation: number;
    observedGeneration?: number;
}

export interface OperationStatusV1 {
    id: string;
    state: "running" | "succeeded" | "failed";
    message?: string;
}

/** `PUT <base>/v1/status`. */
export interface StatusReportV1 extends V1Envelope<"StatusReport"> {
    controllerVersion: string;
    /** The desired-state version this report reflects. */
    desiredStateVersion?: number;
    lease: { holder: boolean; identity: string };
    providers: ProviderStatusV1[];
    endpoints: EndpointStatusV1[];
    operations: OperationStatusV1[];
}

/** The server's answer to a status report. */
export type StatusReportResultV1 = V1Envelope<"StatusReportResult">;

// --- Validation --------------------------------------------------------------------------------------------------------

export class ApiVersionError extends Error {
    constructor(
        message: string,
        readonly received?: unknown
    ) {
        super(message);
        this.name = "ApiVersionError";
    }
}

/**
 * Checks that `payload` is a v1 object of `kind` and returns it typed. Only the envelope is checked here; each kind's
 * own fields are validated by its consumer.
 */
export function expectV1<T extends V1Envelope<string>>(payload: unknown, kind: T["kind"]): T {
    if (typeof payload !== "object" || payload === null) {
        throw new ApiVersionError(`expected a ${kind} object`);
    }
    const envelope = payload as { apiVersion?: unknown; kind?: unknown };
    if (envelope.apiVersion !== API_VERSION_V1) {
        throw new ApiVersionError(
            `unsupported apiVersion ${JSON.stringify(envelope.apiVersion)}; this controller speaks ${SUPPORTED_API_VERSIONS.join(", ")}`,
            envelope.apiVersion
        );
    }
    if (envelope.kind !== kind) {
        throw new ApiVersionError(`expected kind ${kind}, got ${JSON.stringify(envelope.kind)}`);
    }
    return payload as T;
}

/** A payload of the right version whose fields are not what the version says. Its message names the field, never a value. */
export class DnsApiPayloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DnsApiPayloadError";
    }
}

type Fields = Record<string, unknown>;

function isText(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTextList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isText);
}

function isObject(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(entry: Fields, key: string, at: string): string {
    const value: unknown = entry[key];
    if (!isText(value)) {
        throw new DnsApiPayloadError(`'${at}${key}' must be text`);
    }
    return value;
}

function oneOf<T extends string>(entry: Fields, key: string, at: string, allowed: readonly T[], what: string): T {
    if (!(allowed as readonly unknown[]).includes(entry[key])) {
        throw new DnsApiPayloadError(`'${at}${key}' is not ${what} this controller knows`);
    }
    return entry[key] as T;
}

/** `entry[key]` as a list of objects, each read by `read`, or a `DnsApiPayloadError` naming the field. */
function list<T>(entry: Fields, key: string, at: string, read: (item: Fields, at: string) => T): T[] {
    const value: unknown = entry[key];
    if (!Array.isArray(value)) {
        throw new DnsApiPayloadError(`'${at}${key}' must be a list`);
    }
    return value.map((item: unknown, index: number) => {
        const where = `${at}${key}[${index}]`;
        if (!isObject(item)) {
            throw new DnsApiPayloadError(`'${where}' must be an object`);
        }
        return read(item, `${where}.`);
    });
}

function readRecord(entry: Fields, at: string): DnsRecordV1 {
    const dnsName: string = text(entry, "dnsName", at);
    const recordType: DnsRecordKind = oneOf(entry, "recordType", at, DNS_RECORD_KINDS, "a record type");
    if (!isTextList(entry.targets) || entry.targets.length === 0) {
        throw new DnsApiPayloadError(`'${at}targets' must be a list of text`);
    }
    const record: DnsRecordV1 = { dnsName, recordType, targets: [...entry.targets] };
    if (entry.ttl !== undefined) {
        if (!isCount(entry.ttl)) {
            throw new DnsApiPayloadError(`'${at}ttl' must be a whole number`);
        }
        record.ttl = entry.ttl;
    }
    return record;
}

function readSecretRef(value: unknown, at: string): SecretRefV1 {
    if (
        !isObject(value) ||
        (value.backend !== "openbao" && value.backend !== "kubernetes") ||
        !isText(value.path) ||
        !isTextList(value.keys) ||
        !isCount(value.generation)
    ) {
        throw new DnsApiPayloadError(`'${at}secretRef' must be a secret reference`);
    }
    return { backend: value.backend, path: value.path, keys: [...value.keys], generation: value.generation };
}

function readProvider(entry: Fields, at: string): DnsProviderV1 {
    const uid: string = text(entry, "uid", at);
    const type: DnsProviderType = oneOf(entry, "type", at, DNS_PROVIDER_TYPES, "a provider type");
    if (!isTextList(entry.zones)) {
        throw new DnsApiPayloadError(`'${at}zones' must be a list of text`);
    }
    if (!isObject(entry.options)) {
        throw new DnsApiPayloadError(`'${at}options' must be an object`);
    }
    const options: DnsProviderV1["options"] = {};
    for (const [key, value] of Object.entries(entry.options)) {
        if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
            options[key] = value;
        } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
            options[key] = [...value];
        } else {
            throw new DnsApiPayloadError(`'${at}options.${key}' must be text, a number, a switch or a list of text`);
        }
    }
    if (typeof entry.enabled !== "boolean") {
        throw new DnsApiPayloadError(`'${at}enabled' must be true or false`);
    }
    const provider: DnsProviderV1 = { uid, type, zones: [...entry.zones], options, enabled: entry.enabled };
    // A config without credentials (Route 53 through IRSA, unsigned rfc2136) has none; `null` means the same.
    if (entry.secretRef !== undefined && entry.secretRef !== null) {
        provider.secretRef = readSecretRef(entry.secretRef, at);
    }
    return provider;
}

function readEndpointSet(entry: Fields, at: string): EndpointSetV1 {
    const id: string = text(entry, "id", at);
    const providerUid: string = text(entry, "providerUid", at);
    const domainUid: string | undefined = entry.domainUid !== undefined ? text(entry, "domainUid", at) : undefined;
    const records: DnsRecordV1[] = list(entry, "records", at, readRecord);
    return { id, providerUid, ...(domainUid !== undefined ? { domainUid } : {}), records };
}

function readOperation(entry: Fields, at: string): OperationV1 {
    const operation: OperationV1 = {
        id: text(entry, "id", at),
        type: oneOf(entry, "type", at, OPERATION_TYPES, "an operation"),
        providerUid: text(entry, "providerUid", at),
    };
    if (entry.endpointSetId !== undefined) {
        operation.endpointSetId = text(entry, "endpointSetId", at);
    }
    if (entry.records !== undefined) {
        operation.records = list(entry, "records", at, readRecord);
    }
    return operation;
}

/**
 * Reads the server's `DesiredState`: the envelope (`ApiVersionError` for another version or kind, which sends the
 * controller back to the handshake), then every field v1 defines. The result holds only those fields: unknown ones are
 * left out, as v1's additive rule says.
 *
 * A malformed field refuses the **whole** state (`DnsApiPayloadError`), never just its entry: the controller publishes
 * exactly the desired state, so an endpoint set or provider dropped from it would be deleted from the zone. A provider
 * type, record type or operation this controller doesn't know is refused the same way, for the same reason.
 */
export function parseDesiredState(payload: unknown): DesiredStateV1 {
    const state = expectV1<DesiredStateV1>(payload, "DesiredState") as unknown as Fields;
    if (!isCount(state.version)) {
        throw new DnsApiPayloadError("'version' must be a whole number");
    }
    return {
        apiVersion: API_VERSION_V1,
        kind: "DesiredState",
        version: state.version,
        ownerId: text(state, "ownerId", ""),
        externalDnsImage: text(state, "externalDnsImage", ""),
        providers: list(state, "providers", "", readProvider),
        endpointSets: list(state, "endpointSets", "", readEndpointSet),
        operations: list(state, "operations", "", readOperation),
    };
}
