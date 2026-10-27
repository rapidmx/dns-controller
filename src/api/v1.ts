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

export type DnsProviderType = "cloudflare" | "route53" | "rfc2136" | "google" | "azure";
export type DnsRecordKind = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV";

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
    options: Record<string, string | number | boolean>;
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
    type: "test" | "takeover" | "restore";
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
