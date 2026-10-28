///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The Kubernetes objects the controller writes for a desired state (spec 7.4, 7.5): per provider config, one external-dns
// Deployment and the Secret holding its credentials; per endpoint set, one DNSEndpoint. Pure functions: the Reconciler
// applies what these return. No credential value appears in a Deployment, only references to the provider's Secret
// (`<fullname>-dns-<uid>`), which external-dns reads through env or a mounted file; the Secret is the one object that holds
// them (`credentialsSecret()`). Per queued operation (phase C4), one one-shot Job and, for a takeover or a restore, the
// temporary DNSEndpoint it reads (`operationJob()`, `operationEndpoint()`).
import { createHash } from "node:crypto";
import type { DnsProviderType, DnsProviderV1, DnsRecordKind, DnsRecordV1, EndpointSetV1, OperationV1 } from "../api/v1.js";

/** The server-side apply field manager, and the `managed-by` label of everything the controller writes. */
export const FIELD_MANAGER = "rapidmx-dns-controller";

export const LABEL_NAME = "app.kubernetes.io/name";
export const LABEL_INSTANCE = "app.kubernetes.io/instance";
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
/** What an external-dns instance's `--label-filter` selects its DNSEndpoints by. */
export const LABEL_PROVIDER = "rapidmx.io/dns-provider";
export const LABEL_DOMAIN = "rapidmx.io/domain";
export const LABEL_SECRET_KIND = "rapidmx.io/secret-kind";
/** What an operation's Job selects its temporary DNSEndpoint by (a hash of the operation id), instead of the provider label an instance selects by. */
export const LABEL_OPERATION = "rapidmx.io/dns-operation";
/** The operation's id on its Job, for whoever reads the Job. */
export const ANNOTATION_OPERATION = "rapidmx.io/dns-operation-id";
/** The `credentials.generation` the provider's Secret holds: on the pod template it rolls the pod when they change (7.4). */
export const ANNOTATION_CREDENTIALS_GENERATION = "rapidmx.io/credentials-generation";

/** The name of the container an instance's Deployment runs external-dns in. */
export const EXTERNAL_DNS_CONTAINER = "external-dns";

/** external-dns's metrics and health port. */
export const EXTERNAL_DNS_PORT = 7979;

/** The `--provider` name of each provider type. */
const EXTERNAL_DNS_PROVIDERS: Record<DnsProviderType, string> = {
    cloudflare: "cloudflare",
    route53: "aws",
    rfc2136: "rfc2136",
    google: "google",
    azure: "azure",
};

const GOOGLE_CREDENTIALS_DIR = "/etc/external-dns/google";
const AZURE_CONFIG_DIR = "/etc/external-dns/azure";

/** What the manifests are built with besides the desired state, from the controller's configuration. */
export interface ManifestSettings {
    namespace: string;
    fullname: string;
    release: string;
    /** The pinned image every instance runs. */
    externalDnsImage: string;
    externalDnsServiceAccount: string;
    externalDnsResources?: Record<string, unknown>;
}

/** A Kubernetes object as the controller writes it. */
export interface Manifest {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; labels: Record<string, string>; annotations?: Record<string, string> };
    spec: Record<string, unknown>;
}

/** The provider's credentials Secret: its data is base64, as the API server stores it. */
export interface SecretManifest {
    apiVersion: "v1";
    kind: "Secret";
    type: "Opaque";
    metadata: Manifest["metadata"] & { ownerReferences: { apiVersion: string; kind: string; name: string; uid: string }[] };
    data: Record<string, string>;
}

/** One `DNSEndpoint` entry, as external-dns's CRD names its fields. */
export interface DnsEndpointEntry {
    dnsName: string;
    recordType: DnsRecordKind;
    targets: string[];
    recordTTL?: number;
    providerSpecific?: { name: string; value: string }[];
}

/** An endpoint set id: a DNS label-like suffix of at most 180 characters, so `<fullname>-<id>` stays a valid name. */
export const ENDPOINT_SET_ID: RegExp = /^[a-z0-9]([a-z0-9-]{0,178}[a-z0-9])?$/;

export function deploymentName(settings: Pick<ManifestSettings, "fullname">, providerUid: string): string {
    return `${settings.fullname}-external-dns-${providerUid}`;
}

/** The provider's credentials Secret, written by the controller from the credentials the server sends it (7.3). */
export function credentialsSecretName(settings: Pick<ManifestSettings, "fullname">, providerUid: string): string {
    return `${settings.fullname}-dns-${providerUid}`;
}

/** The desired state names an endpoint set by id (`domain-example-com`, `hosts-<uid>`); the controller prefixes the release. */
export function dnsEndpointName(settings: Pick<ManifestSettings, "fullname">, endpointSetId: string): string {
    return `${settings.fullname}-${endpointSetId}`;
}

/** The hash of an operation id that stands for it in names and label values, which an id of any shape can't safely be. */
function operationHash(operationId: string): string {
    return createHash("sha256").update(operationId).digest("hex").slice(0, 16);
}

/**
 * The name of an operation's Job and of its temporary DNSEndpoint: the release's name and a hash of the operation id. A
 * Job's name is at most 63 characters (its pods carry it as a label value), so a long release name is cut.
 */
export function operationName(settings: Pick<ManifestSettings, "fullname">, operationId: string): string {
    return `${settings.fullname.slice(0, 40).replace(/-+$/, "")}-op-${operationHash(operationId)}`;
}

/** The labels of every object this controller writes for this release: what its lists select. */
export function managedLabels(settings: Pick<ManifestSettings, "release">): Record<string, string> {
    return { [LABEL_MANAGED_BY]: FIELD_MANAGER, [LABEL_INSTANCE]: settings.release };
}

/** Whether a Secret's labels say this controller wrote it for provider `uid` (the same test before any change, delete or run). */
export function isOurSecret(labels: Record<string, string> | undefined, uid: string): boolean {
    return labels?.[LABEL_MANAGED_BY] === FIELD_MANAGER && labels[LABEL_SECRET_KIND] === "dns" && labels[LABEL_PROVIDER] === uid;
}

/**
 * A TXT value as a `DNSEndpoint` target for Cloudflare, Route 53 and Google (Azure and rfc2136 differ, `txtTargets()`):
 * quoted (4.2), the form the TXT registry writes its own records in and those providers return, so the regular instance
 * finds nothing to rewrite on every sync. A value over one 255-byte
 * character-string (a 2048-bit DKIM key) is cut into several, `"..." "..."`, as a zone file writes it and as Route 53
 * requires; a cut never splits a character, and `"` and `\` are escaped after cutting, so an escape stays whole.
 */
export function quoteTxtTarget(value: string): string {
    const bytes: Buffer = Buffer.from(value, "utf8");
    const parts: string[] = [];
    let start = 0;
    do {
        let end: number = Math.min(start + 255, bytes.length);
        // Back off a UTF-8 continuation byte (10xxxxxx) so the cut falls between characters.
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
            end--;
        }
        parts.push(bytes.subarray(start, end).toString("utf8"));
        start = end;
    } while (start < bytes.length);
    return parts.map((part) => `"${part.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(" ");
}

/** A value rfc2136 reads back exactly as written unquoted: one character-string with nothing zone-file text treats specially. */
const RFC2136_PLAIN_TXT: RegExp = /^(?:(?!["\\;()$@])[\x21-\x7e]){1,255}$/;

/**
 * A TXT record's targets as `type`'s external-dns v0.23.0 provider keeps them, or undefined when it can't keep the record
 * (left out, like rfc2136's MX and SRV, 4.2):
 *
 * - **Azure** writes and reads its first target verbatim, so a value is passed unquoted (quotes would be published as part
 * of it), and a record of several values can't be kept.
 * - **rfc2136** writes a target as zone-file text but reads back the bare character-strings, which `Targets.Same` compares
 * as they are, and it removes an old value by parsing what it read: a value with a space, `;` or a quote can never be
 * updated or deleted (removing `v=DMARC1; p=none;` parses as `v=DMARC1` and removes nothing). Only plain values are kept,
 * written unquoted so they read back the same.
 * - **The others** take the quoted zone-file form (`quoteTxtTarget()`).
 */
export function txtTargets(targets: string[], type: DnsProviderType): string[] | undefined {
    switch (type) {
        case "azure":
            return targets.length === 1 ? [...targets] : undefined;
        case "rfc2136":
            return targets.every((target) => RFC2136_PLAIN_TXT.test(target)) ? [...targets] : undefined;
        default:
            return targets.map(quoteTxtTarget);
    }
}

/**
 * The ownership record the TXT registry writes for `record` (9.3): `rmx-<kind>.<name>`, naming the **regular** endpoint
 * as its resource, and **without a TTL**, as the registry writes it. The regular endpoints never carry one (external-dns
 * writes them); the takeover Job's temporary endpoint does (C4).
 */
export function ownershipEndpoint(
    record: Pick<DnsRecordV1, "dnsName" | "recordType">,
    ownerId: string,
    namespace: string,
    endpointName: string
): DnsEndpointEntry {
    return {
        dnsName: `rmx-${record.recordType.toLowerCase()}.${record.dnsName}`,
        recordType: "TXT",
        targets: [`"heritage=external-dns,external-dns/owner=${ownerId},external-dns/resource=crd/${namespace}/${endpointName}"`],
    };
}

/** Whether the desired state's image is the pin: the same reference, or the pin's tag when the pin adds a digest. */
export function acceptsExternalDnsImage(pin: string, desired: string): boolean {
    const at: number = pin.indexOf("@");
    return desired === pin || (at > 0 && desired === pin.slice(0, at));
}

/** The record kinds an instance manages: rfc2136 can't keep MX or SRV (its AXFR reader skips them, 4.2). */
export function managedRecordKinds(type: DnsProviderType): DnsRecordKind[] {
    return type === "rfc2136" ? ["A", "AAAA", "CNAME", "TXT"] : ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"];
}

function textOption(provider: DnsProviderV1, key: string): string | undefined {
    const value: unknown = provider.options[key];
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** A list option; a single value sent as text is a list of one. */
function listOption(provider: DnsProviderV1, key: string): string[] {
    const value: unknown = provider.options[key];
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string" && item !== "");
    }
    return typeof value === "string" && value !== "" ? [value] : [];
}

/** The flags each type's non-secret options become. Unknown options, and options of the wrong shape, are left out. */
function providerArgs(provider: DnsProviderV1): string[] {
    const args: string[] = [];
    const flag = (name: string, value: string | undefined): void => {
        if (value !== undefined) {
            args.push(`--${name}=${value}`);
        }
    };
    switch (provider.type) {
        case "cloudflare":
            // One id per zone: what lets a token scoped to its zones work.
            listOption(provider, "zoneIds").forEach((id) => flag("zone-id-filter", id));
            break;
        case "route53":
            flag("aws-zone-type", textOption(provider, "zoneType"));
            flag("aws-assume-role", textOption(provider, "assumeRoleArn"));
            break;
        case "rfc2136": {
            listOption(provider, "hosts").forEach((host) => flag("rfc2136-host", host));
            const port: unknown = provider.options.port;
            flag("rfc2136-port", typeof port === "number" ? String(port) : undefined);
            flag("rfc2136-zone", textOption(provider, "zone"));
            flag("rfc2136-tsig-keyname", textOption(provider, "tsigKeyName"));
            flag("rfc2136-tsig-secret-alg", textOption(provider, "tsigAlgorithm"));
            if (provider.options.insecure === true) {
                args.push("--rfc2136-insecure");
            }
            // Sync needs to read the zone; without AXFR external-dns behaves as if create-only.
            args.push("--rfc2136-axfr");
            break;
        }
        case "google":
            flag("google-project", textOption(provider, "project"));
            break;
        case "azure":
            flag("azure-config-file", `${AZURE_CONFIG_DIR}/azure.json`);
            flag("azure-subscription-id", textOption(provider, "subscriptionId"));
            flag("azure-resource-group", textOption(provider, "resourceGroup"));
            break;
    }
    return args;
}

/**
 * The zones of the other provider configs that lie under one of `provider`'s zones (`sub.example.com` under
 * `example.com`): its instance is kept out of them with `--exclude-domains`. Every instance shares the owner id, so
 * without it the parent's instance would take the nested config's records for its own and delete them on every sync.
 */
export function nestedZones(provider: DnsProviderV1, providers: DnsProviderV1[]): string[] {
    const nested: string[] = [];
    for (const other of providers.filter((p) => p.uid !== provider.uid)) {
        for (const zone of other.zones) {
            if (provider.zones.some((own) => zone.endsWith(`.${own}`)) && !nested.includes(zone)) {
                nested.push(zone);
            }
        }
    }
    return nested;
}

/** The arguments that select what external-dns acts on, which an instance and an operation's Job share: the source, `labelFilter`, the provider and its zones, kept out of `excludedZones`. */
function selectionArgs(provider: DnsProviderV1, labelFilter: string, namespace: string, excludedZones: string[]): string[] {
    return [
        "--source=crd",
        "--crd-source-apiversion=externaldns.k8s.io/v1alpha1",
        "--crd-source-kind=DNSEndpoint",
        `--namespace=${namespace}`,
        `--label-filter=${labelFilter}`,
        `--provider=${EXTERNAL_DNS_PROVIDERS[provider.type]}`,
        ...provider.zones.map((zone) => `--domain-filter=${zone}`),
        ...excludedZones.map((zone) => `--exclude-domains=${zone}`),
    ];
}

/**
 * external-dns v0.23.0's arguments for `provider` (spec 7.4), kept out of `excludedZones` (`nestedZones()`). Credentials
 * are never among them.
 */
export function externalDnsArgs(provider: DnsProviderV1, ownerId: string, namespace: string, excludedZones: string[] = []): string[] {
    return [
        ...selectionArgs(provider, `${LABEL_PROVIDER}=${provider.uid}`, namespace, excludedZones),
        "--registry=txt",
        `--txt-owner-id=${ownerId}`,
        // With the record type and a trailing dot, an apex record's ownership TXT stays inside the zone and never sits
        // next to a CNAME (7.4). It never changes.
        "--txt-prefix=rmx-%{record_type}.",
        ...managedRecordKinds(provider.type).map((kind) => `--managed-record-types=${kind}`),
        // No default since v0.22.0.
        "--policy=sync",
        "--interval=1m",
        "--events",
        "--log-format=json",
        `--metrics-address=:${EXTERNAL_DNS_PORT}`,
        ...providerArgs(provider),
    ];
}

/**
 * external-dns's arguments for an operation's one-shot Job (spec 9.3): the noop registry, which treats every record as its
 * own, and `--policy=upsert-only`, so the Job writes what its temporary endpoint holds and deletes nothing; `--once`;
 * and the dedicated label filter, which selects that endpoint alone. A credentials test adds `--dry-run`. No owner id,
 * no TXT prefix and no `--events`: nothing is registered, and the Job's ServiceAccount (the instances') can't create events.
 */
function operationArgs(operation: OperationV1, provider: DnsProviderV1, namespace: string, excludedZones: string[]): string[] {
    return [
        ...selectionArgs(provider, `${LABEL_OPERATION}=${operationHash(operation.id)}`, namespace, excludedZones),
        "--registry=noop",
        "--policy=upsert-only",
        ...managedRecordKinds(provider.type).map((kind) => `--managed-record-types=${kind}`),
        "--once",
        ...(operation.type === "test" ? ["--dry-run"] : []),
        "--log-format=json",
        ...providerArgs(provider),
    ];
}

/** The credential fields a type can't run without. */
function requiredCredentials(provider: DnsProviderV1): string[] {
    switch (provider.type) {
        case "cloudflare":
            return ["apiToken"];
        case "rfc2136":
            return provider.options.insecure === true ? [] : ["tsigSecret"];
        case "google":
            return ["serviceAccountJson"];
        case "azure":
            return ["clientId", "clientSecret"];
        default:
            // Route 53 runs without keys through IRSA.
            return [];
    }
}

/** Why `provider` can't run (credential fields it has not saved), or undefined. Such an instance is scaled to zero. */
export function credentialsProblem(provider: DnsProviderV1): string | undefined {
    const keys: string[] = provider.credentials?.keys ?? [];
    const missing: string[] = requiredCredentials(provider).filter((key) => !keys.includes(key));
    return missing.length > 0 ? `missing credentials: ${missing.join(", ")}` : undefined;
}

interface CredentialWiring {
    env: Record<string, unknown>[];
    volumes: Record<string, unknown>[];
    volumeMounts: Record<string, unknown>[];
}

/** How each type's credentials reach external-dns: env from the provider's Secret, or a file mounted from it. */
function credentialWiring(provider: DnsProviderV1, settings: ManifestSettings): CredentialWiring {
    const secret: string = credentialsSecretName(settings, provider.uid);
    const keys: string[] = provider.credentials?.keys ?? [];
    const wiring: CredentialWiring = { env: [], volumes: [], volumeMounts: [] };
    const fromSecret = (name: string, key: string): void => {
        if (keys.includes(key)) {
            wiring.env.push({ name, valueFrom: { secretKeyRef: { name: secret, key } } });
        }
    };
    const mount = (dir: string, key: string, path: string): void => {
        wiring.volumes.push({ name: "credentials", secret: { secretName: secret, items: [{ key, path }] } });
        wiring.volumeMounts.push({ name: "credentials", mountPath: dir, readOnly: true });
    };
    switch (provider.type) {
        case "cloudflare":
            fromSecret("CF_API_TOKEN", "apiToken");
            break;
        case "route53": {
            const region: string | undefined = textOption(provider, "region");
            if (region) {
                wiring.env.push({ name: "AWS_REGION", value: region });
            }
            // Both or neither (the server checks): neither is IRSA on the ServiceAccount.
            if (keys.includes("accessKeyId") && keys.includes("secretAccessKey")) {
                fromSecret("AWS_ACCESS_KEY_ID", "accessKeyId");
                fromSecret("AWS_SECRET_ACCESS_KEY", "secretAccessKey");
            }
            break;
        }
        case "rfc2136":
            // Every flag has an EXTERNAL_DNS_<FLAG> variable: the secret stays out of the arguments.
            fromSecret("EXTERNAL_DNS_RFC2136_TSIG_SECRET", "tsigSecret");
            break;
        case "google":
            if (keys.includes("serviceAccountJson")) {
                wiring.env.push({ name: "GOOGLE_APPLICATION_CREDENTIALS", value: `${GOOGLE_CREDENTIALS_DIR}/credentials.json` });
                mount(GOOGLE_CREDENTIALS_DIR, "serviceAccountJson", "credentials.json");
            }
            break;
        case "azure":
            // azure.json is assembled by the controller when it writes the Secret (credentialsSecret()).
            if (keys.includes("clientId") || keys.includes("clientSecret")) {
                mount(AZURE_CONFIG_DIR, "azure.json", "azure.json");
            }
            break;
    }
    return wiring;
}

/** The labels of a provider's instance; all but `managed-by` also select its pods, and the selector never changes. */
function instanceSelector(provider: DnsProviderV1, settings: ManifestSettings): Record<string, string> {
    return { [LABEL_NAME]: "external-dns", [LABEL_INSTANCE]: settings.release, [LABEL_PROVIDER]: provider.uid };
}

/**
 * The external-dns container of an instance or an operation's Job: the pinned image with `args`, the credentials by
 * reference, and the hardening (read-only root filesystem, no capabilities).
 */
function externalDnsContainer(settings: ManifestSettings, args: string[], wiring: CredentialWiring): Record<string, unknown> {
    return {
        name: EXTERNAL_DNS_CONTAINER,
        image: settings.externalDnsImage,
        args,
        ...(wiring.env.length > 0 ? { env: wiring.env } : {}),
        ...(settings.externalDnsResources ? { resources: settings.externalDnsResources } : {}),
        securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            capabilities: { drop: ["ALL"] },
        },
        ...(wiring.volumeMounts.length > 0 ? { volumeMounts: wiring.volumeMounts } : {}),
    };
}

/** The pod spec around `container`: the instances' ServiceAccount and the pod hardened like the controller's (external-dns's image runs as the distroless nonroot user). */
function externalDnsPodSpec(settings: ManifestSettings, container: Record<string, unknown>, wiring: CredentialWiring): Record<string, unknown> {
    return {
        serviceAccountName: settings.externalDnsServiceAccount,
        securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [container],
        ...(wiring.volumes.length > 0 ? { volumes: wiring.volumes } : {}),
    };
}

/**
 * The provider's external-dns Deployment (7.4): one replica (none while disabled or without its credentials),
 * `Recreate` since external-dns has no leader election, the pinned image, and the pod hardened like the controller's.
 * `credentialsGeneration` goes on the pod template, so new credentials roll the pod; `excludedZones` are the nested zones
 * of other configs (`nestedZones()`).
 */
export function externalDnsDeployment(
    provider: DnsProviderV1,
    ownerId: string,
    settings: ManifestSettings,
    credentialsGeneration?: number,
    excludedZones: string[] = []
): Manifest {
    const selector: Record<string, string> = instanceSelector(provider, settings);
    const labels: Record<string, string> = {
        [LABEL_NAME]: "external-dns",
        [LABEL_INSTANCE]: settings.release,
        [LABEL_MANAGED_BY]: FIELD_MANAGER,
        [LABEL_PROVIDER]: provider.uid,
    };
    const wiring: CredentialWiring = credentialWiring(provider, settings);
    const container: Record<string, unknown> = {
        ...externalDnsContainer(settings, externalDnsArgs(provider, ownerId, settings.namespace, excludedZones), wiring),
        ports: [{ name: "http", containerPort: EXTERNAL_DNS_PORT, protocol: "TCP" }],
        livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
        readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 10, timeoutSeconds: 5 },
    };
    const runs: boolean = provider.enabled && credentialsProblem(provider) === undefined;
    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: deploymentName(settings, provider.uid), namespace: settings.namespace, labels },
        spec: {
            replicas: runs ? 1 : 0,
            strategy: { type: "Recreate" },
            revisionHistoryLimit: 2,
            selector: { matchLabels: selector },
            template: {
                metadata: {
                    labels,
                    ...(provider.credentials && credentialsGeneration !== undefined
                        ? { annotations: { [ANNOTATION_CREDENTIALS_GENERATION]: String(credentialsGeneration) } }
                        : {}),
                },
                spec: externalDnsPodSpec(settings, container, wiring),
            },
        },
    };
}

/** How long an operation's Job may run before Kubernetes fails it: a pod stuck on a missing Secret, or a provider that never answers. */
const OPERATION_DEADLINE_SECONDS = 300;

/**
 * The one-shot Job of an operation (spec 9.3, 9.5): external-dns from the pinned image with the provider's credentials and
 * arguments, the noop registry, `--policy=upsert-only` and `--once` (`--dry-run` too for a credentials test), selecting
 * only the operation's temporary DNSEndpoint (`operationEndpoint()`) by its own label. It fails rather than retries
 * (`backoffLimit: 0`): an operation is the admin's to repeat, and the failure is what is reported back. Its pod carries
 * neither the instances' labels nor the provider label, so no instance's Deployment selects it, and the container's
 * last log lines become the pod's termination message when it fails, which is the reason reported.
 *
 * It has no `ttlSecondsAfterFinished`: the Job is the durable record of the result, so it stays until the controller deletes it
 * (once the server stops listing the operation); a TTL would let a result the server has not yet taken be lost and the
 * operation run again.
 *
 * Created with POST, never applied: the controller's Role has `create`, `get`, `list` and `delete` on Jobs (7.6).
 */
export function operationJob(operation: OperationV1, provider: DnsProviderV1, settings: ManifestSettings, excludedZones: string[] = []): Manifest {
    const hash: string = operationHash(operation.id);
    const labels: Record<string, string> = { ...managedLabels(settings), [LABEL_OPERATION]: hash };
    const wiring: CredentialWiring = credentialWiring(provider, settings);
    const container: Record<string, unknown> = {
        ...externalDnsContainer(settings, operationArgs(operation, provider, settings.namespace, excludedZones), wiring),
        terminationMessagePolicy: "FallbackToLogsOnError",
    };
    return {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: operationName(settings, operation.id), namespace: settings.namespace, labels, annotations: { [ANNOTATION_OPERATION]: operation.id } },
        spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: OPERATION_DEADLINE_SECONDS,
            template: {
                metadata: { labels: { [LABEL_NAME]: "external-dns-operation", ...labels } },
                spec: { restartPolicy: "Never", ...externalDnsPodSpec(settings, container, wiring) },
            },
        },
    };
}

const GUID: RegExp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The credential fields each type reads from its Secret by name; Azure's are not among them, they go into `azure.json`. */
const SECRET_FIELDS: Record<DnsProviderType, readonly string[]> = {
    cloudflare: ["apiToken"],
    route53: ["accessKeyId", "secretAccessKey"],
    rfc2136: ["tsigSecret"],
    google: ["serviceAccountJson"],
    azure: [],
};

const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/**
 * The provider's Secret (7.4), the one external-dns reads its credentials from. It holds `values`, the credentials the
 * server sent, under the field names the Deployment refers to (`credentialWiring()`); a field the type doesn't read is
 * left out. Azure reads a single file whose tenant isn't a flag, so its Secret holds `azure.json`, built here with
 * `JSON.stringify` from the tenant in the options (which must be exactly a GUID) and the client id and secret.
 *
 * The Secret is labelled like everything the controller writes, carries the generation of the credentials it holds (the
 * Reconciler compares it with the desired one, and the pod template rolls on it) and is owned by the provider's
 * Deployment (`ownerUid`), so it goes with it. Values are base64 data, never in a label or annotation.
 */
export function credentialsSecret(provider: DnsProviderV1, values: Record<string, string>, settings: ManifestSettings, ownerUid: string): SecretManifest {
    const data: Record<string, string> = {};
    if (provider.type === "azure") {
        const tenantId: string | undefined = textOption(provider, "tenantId");
        if (!tenantId || !GUID.test(tenantId)) {
            throw new Error("'tenantId' must be a GUID");
        }
        if (values.clientId !== undefined && values.clientSecret !== undefined) {
            data["azure.json"] = base64(JSON.stringify({ tenantId, aadClientId: values.clientId, aadClientSecret: values.clientSecret }));
        }
    }
    for (const field of SECRET_FIELDS[provider.type]) {
        if (values[field] !== undefined) {
            data[field] = base64(values[field]);
        }
    }
    return {
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
            name: credentialsSecretName(settings, provider.uid),
            namespace: settings.namespace,
            labels: { ...managedLabels(settings), [LABEL_PROVIDER]: provider.uid, [LABEL_SECRET_KIND]: "dns" },
            annotations: { [ANNOTATION_CREDENTIALS_GENERATION]: String(provider.credentials?.generation) },
            // Without `blockOwnerDeletion` or `controller`: setting either needs a right on the Deployment's finalizers.
            ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: deploymentName(settings, provider.uid), uid: ownerUid }],
        },
        data,
    };
}

const LABEL_VALUE: RegExp = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * One record as a DNSEndpoint entry, or undefined when the provider can't keep it: TXT targets in the provider's form
 * (`txtTargets()`), the TTL when the server sent one, Cloudflare's hosts unproxied.
 */
function endpointEntry(record: DnsRecordV1, type: DnsProviderType): DnsEndpointEntry | undefined {
    const targets: string[] | undefined = record.recordType === "TXT" ? txtTargets(record.targets, type) : [...record.targets];
    if (!targets) {
        return undefined;
    }
    const entry: DnsEndpointEntry = { dnsName: record.dnsName, recordType: record.recordType, targets };
    if (record.ttl !== undefined) {
        entry.recordTTL = record.ttl;
    }
    // Mail hosts must never be proxied; external-dns forces MX, TXT and SRV unproxied itself.
    if (type === "cloudflare" && (record.recordType === "A" || record.recordType === "AAAA" || record.recordType === "CNAME")) {
        entry.providerSpecific = [{ name: "cloudflare/proxied", value: "false" }];
    }
    return entry;
}

/**
 * The DNSEndpoint of one endpoint set (7.5), labelled for its provider's instance (reassigning a domain rewrites the
 * label: the old instance deletes the records, the new one creates them). A record the provider can't keep (a kind it
 * doesn't manage, a TXT value it can't round-trip) is left out.
 */
export function dnsEndpoint(set: EndpointSetV1, providerType: DnsProviderType, settings: ManifestSettings): Manifest {
    const labels: Record<string, string> = { ...managedLabels(settings), [LABEL_PROVIDER]: set.providerUid };
    // A domain name longer than a label value can be (63) goes without the label; nothing selects by it.
    if (set.domainUid !== undefined && LABEL_VALUE.test(set.domainUid)) {
        labels[LABEL_DOMAIN] = set.domainUid;
    }
    return {
        apiVersion: "externaldns.k8s.io/v1alpha1",
        kind: "DNSEndpoint",
        metadata: { name: dnsEndpointName(settings, set.id), namespace: settings.namespace, labels },
        spec: { endpoints: endpointEntries(set.records, providerType) },
    };
}

/** `records` as the DNSEndpoint entries `type`'s provider keeps, in order; what it can't keep is left out. */
export function endpointEntries(records: DnsRecordV1[], type: DnsProviderType): DnsEndpointEntry[] {
    const kinds: DnsRecordKind[] = managedRecordKinds(type);
    const entries: DnsEndpointEntry[] = [];
    for (const record of records.filter((r) => kinds.includes(r.recordType))) {
        const entry: DnsEndpointEntry | undefined = endpointEntry(record, type);
        if (entry) {
            entries.push(entry);
        }
    }
    return entries;
}

/**
 * The temporary DNSEndpoint an operation's Job reads (spec 9.3, 9.5), labelled for the Job's own label filter and not for
 * any instance's, so only the Job sees it. Holds the operation's records in the provider's form, exactly as the regular
 * endpoint would; and, for a takeover, the ownership record of each name and type (`ownershipEndpoint()`) that the TXT
 * registry would have written, naming the **regular** endpoint of the set as its resource and without a TTL, so that the
 * regular instance finds the records its own and nothing to change. A restore writes none: its values go back unowned.
 */
export function operationEndpoint(operation: OperationV1, providerType: DnsProviderType, ownerId: string, settings: ManifestSettings): Manifest {
    const endpoints: DnsEndpointEntry[] = endpointEntries(operation.records ?? [], providerType);
    if (operation.type === "takeover") {
        if (!operation.endpointSetId) {
            throw new Error("a takeover needs the endpoint set it takes records over for");
        }
        const regular: string = dnsEndpointName(settings, operation.endpointSetId);
        const owned: Set<string> = new Set();
        for (const entry of [...endpoints]) {
            const key = `${entry.recordType} ${entry.dnsName}`;
            if (!owned.has(key)) {
                owned.add(key);
                endpoints.push(ownershipEndpoint(entry, ownerId, settings.namespace, regular));
            }
        }
    }
    return {
        apiVersion: "externaldns.k8s.io/v1alpha1",
        kind: "DNSEndpoint",
        metadata: {
            name: operationName(settings, operation.id),
            namespace: settings.namespace,
            labels: { ...managedLabels(settings), [LABEL_OPERATION]: operationHash(operation.id) },
        },
        spec: { endpoints },
    };
}
