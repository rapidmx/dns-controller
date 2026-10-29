import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1, type DnsProviderV1, type EndpointSetV1, type OperationV1 } from "../../src/api/v1.js";
import {
    acceptsExternalDnsImage,
    credentialsProblem,
    credentialsSecret,
    dnsEndpoint,
    dnsEndpointName,
    externalDnsArgs,
    externalDnsDeployment,
    isOurSecret,
    managedRecordKinds,
    nestedZones,
    operationEndpoint,
    operationJob,
    operationName,
    ownershipEndpoint,
    quoteTxtTarget,
    txtTargets,
    type ManifestSettings,
} from "../../src/reconcile/manifests.js";

const PIN = "registry.k8s.io/external-dns/external-dns:v0.23.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const settings: ManifestSettings = {
    namespace: "rapidmx",
    fullname: "mail",
    release: "mail",
    externalDnsImage: PIN,
    externalDnsServiceAccount: "mail-external-dns",
};

/** The shared contract fixture: what the server really sends. */
const fixture: DesiredStateV1 = parseDesiredState(JSON.parse(readFileSync(new URL("../fixtures/api/v1/desired-state.json", import.meta.url), "utf8")));
const cloudflare: DnsProviderV1 = fixture.providers[0];
const OWNER = fixture.ownerId;

function provider(patch: Partial<DnsProviderV1>): DnsProviderV1 {
    return { uid: "p1", type: "cloudflare", zones: ["example.com"], options: {}, enabled: true, ...patch };
}

type Container = {
    args: string[];
    env?: { name: string; value?: string; valueFrom?: unknown }[];
    volumeMounts?: unknown[];
};
const container = (deployment: ReturnType<typeof externalDnsDeployment>): Container =>
    (deployment as unknown as { spec: { template: { spec: { containers: Container[] } } } }).spec.template.spec.containers[0];
const podSpec = (deployment: ReturnType<typeof externalDnsDeployment>): Record<string, unknown> =>
    (deployment as unknown as { spec: { template: { spec: Record<string, unknown> } } }).spec.template.spec;

/** The arguments every instance has, in order, before the provider-specific ones (spec 7.4). */
function commonArgs(uid: string, type: string, zones: string[], kinds: string[]): string[] {
    return [
        "--source=crd",
        "--crd-source-apiversion=externaldns.k8s.io/v1alpha1",
        "--crd-source-kind=DNSEndpoint",
        "--namespace=rapidmx",
        `--label-filter=rapidmx.io/dns-provider=${uid}`,
        `--provider=${type}`,
        ...zones.map((zone) => `--domain-filter=${zone}`),
        "--registry=txt",
        `--txt-owner-id=${OWNER}`,
        "--txt-prefix=rmx-%{record_type}.",
        ...kinds.map((kind) => `--managed-record-types=${kind}`),
        "--policy=sync",
        "--interval=1m",
        "--events",
        "--log-format=json",
        "--metrics-address=:7979",
    ];
}
const ALL_KINDS = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"];

describe("quoteTxtTarget", () => {
    it("writes a value as one quoted string, the form the TXT registry and the providers use", () => {
        expect(quoteTxtTarget("v=spf1 mx ~all")).toBe('"v=spf1 mx ~all"');
        expect(quoteTxtTarget("")).toBe('""');
    });

    it("escapes quotes and backslashes inside the value", () => {
        expect(quoteTxtTarget('say "hi" \\o/')).toBe('"say \\"hi\\" \\\\o/"');
    });

    it("splits a value longer than one 255-byte character-string (a 2048-bit DKIM key) into several", () => {
        const value = `v=DKIM1; k=rsa; p=${"A".repeat(392)}`;
        const quoted = quoteTxtTarget(value);
        expect(quoted).toBe(`"${value.slice(0, 255)}" "${value.slice(255)}"`);
        expect(quoteTxtTarget("x".repeat(255))).toBe(`"${"x".repeat(255)}"`);
        expect(quoteTxtTarget("x".repeat(510))).toBe(`"${"x".repeat(255)}" "${"x".repeat(255)}"`);
    });

    it("counts bytes, never cutting a character in two", () => {
        expect(quoteTxtTarget(`${"a".repeat(254)}é`)).toBe(`"${"a".repeat(254)}" "é"`);
        expect(quoteTxtTarget(`${"a".repeat(253)}é`)).toBe(`"${"a".repeat(253)}é"`);
    });

    it("cuts before escaping, so an escaped quote never straddles two strings", () => {
        expect(quoteTxtTarget(`${"a".repeat(254)}"b`)).toBe(`"${"a".repeat(254)}\\"" "b"`);
    });
});

describe("txtTargets", () => {
    const dkim = `v=DKIM1; k=rsa; p=${"A".repeat(392)}`;

    it("quotes for Cloudflare, Route 53 and Google, which take and return the zone-file form", () => {
        for (const type of ["cloudflare", "route53", "google"] as const) {
            expect(txtTargets(["v=spf1 mx ~all", "keep-me"], type)).toEqual(['"v=spf1 mx ~all"', '"keep-me"']);
            expect(txtTargets([dkim], type)).toEqual([quoteTxtTarget(dkim)]);
        }
    });

    it("passes Azure's one value verbatim, since Azure stores quotes as part of it, and can't keep a set of several", () => {
        expect(txtTargets(["v=spf1 mx ~all"], "azure")).toEqual(["v=spf1 mx ~all"]);
        expect(txtTargets([dkim], "azure")).toEqual([dkim]);
        // external-dns v0.23.0 writes and reads only the first target on Azure.
        expect(txtTargets(["v=spf1 mx ~all", "keep-me"], "azure")).toBeUndefined();
    });

    it("keeps for rfc2136 only plain values, unquoted, which it reads back exactly as written", () => {
        expect(txtTargets(["rapidmx-domain-verification=3f9c1d", "keep-me"], "rfc2136")).toEqual(["rapidmx-domain-verification=3f9c1d", "keep-me"]);
        // A space, ';' or quote can't be updated or deleted by its provider, and over 255 bytes reads back as several.
        for (const value of ["v=spf1 mx ~all", "v=DMARC1;p=none", 'a"b', "a\b", "a(b)", "$ORIGIN", "@", "é", "", "x".repeat(256), dkim]) {
            expect(txtTargets(["keep-me", value], "rfc2136")).toBeUndefined();
        }
        expect(txtTargets(["x".repeat(255)], "rfc2136")).toEqual(["x".repeat(255)]);
    });
});

describe("ownershipEndpoint", () => {
    it("is the TXT registry's own record: rmx-<kind>.<name>, quoted, naming the regular endpoint, and without a TTL", () => {
        expect(ownershipEndpoint({ dnsName: "example.com", recordType: "MX" }, OWNER, "rapidmx", "mail-domain-example-com")).toEqual({
            dnsName: "rmx-mx.example.com",
            recordType: "TXT",
            targets: [`"heritage=external-dns,external-dns/owner=${OWNER},external-dns/resource=crd/rapidmx/mail-domain-example-com"`],
        });
        expect(ownershipEndpoint({ dnsName: "openpgpkey.example.com", recordType: "CNAME" }, OWNER, "rapidmx", "x")).toMatchObject({
            dnsName: "rmx-cname.openpgpkey.example.com",
        });
    });
});

describe("acceptsExternalDnsImage", () => {
    it("accepts the pin itself, or the pin's tag when the pin also names a digest", () => {
        expect(acceptsExternalDnsImage(PIN, PIN)).toBe(true);
        expect(acceptsExternalDnsImage(PIN, "registry.k8s.io/external-dns/external-dns:v0.23.0")).toBe(true);
        expect(acceptsExternalDnsImage("registry.k8s.io/external-dns/external-dns:v0.23.0", "registry.k8s.io/external-dns/external-dns:v0.23.0")).toBe(true);
    });

    it("refuses any other image, another digest included", () => {
        expect(acceptsExternalDnsImage(PIN, "registry.k8s.io/external-dns/external-dns:v0.24.0")).toBe(false);
        expect(acceptsExternalDnsImage(PIN, "registry.k8s.io/external-dns/external-dns:v0.23.0@sha256:ffff")).toBe(false);
        expect(acceptsExternalDnsImage("registry.k8s.io/external-dns/external-dns:v0.23.0", PIN)).toBe(false);
        expect(acceptsExternalDnsImage(PIN, "evil.example/external-dns:v0.23.0")).toBe(false);
    });
});

describe("managedRecordKinds", () => {
    it("lists MX, TXT and SRV next to A/AAAA/CNAME, except for rfc2136, whose AXFR reader skips MX and SRV", () => {
        expect(managedRecordKinds("cloudflare")).toEqual(ALL_KINDS);
        expect(managedRecordKinds("route53")).toEqual(ALL_KINDS);
        expect(managedRecordKinds("google")).toEqual(ALL_KINDS);
        expect(managedRecordKinds("azure")).toEqual(ALL_KINDS);
        expect(managedRecordKinds("rfc2136")).toEqual(["A", "AAAA", "CNAME", "TXT"]);
    });
});

describe("externalDnsArgs", () => {
    it("gives the exact v0.23.0 arguments of spec 7.4 for the fixture's Cloudflare config", () => {
        expect(externalDnsArgs(cloudflare, OWNER, "rapidmx")).toEqual([
            ...commonArgs("cloudflare-main", "cloudflare", ["example.com"], ALL_KINDS),
            "--zone-id-filter=0123456789abcdef0123456789abcdef",
        ]);
    });

    it("gives one --domain-filter per zone and one --zone-id-filter per zone id", () => {
        const args = externalDnsArgs(provider({ zones: ["example.com", "example.org"], options: { zoneIds: ["a".repeat(32), "b".repeat(32)] } }), OWNER, "rapidmx");
        expect(args.filter((a) => a.startsWith("--domain-filter="))).toEqual(["--domain-filter=example.com", "--domain-filter=example.org"]);
        expect(args.filter((a) => a.startsWith("--zone-id-filter="))).toEqual([`--zone-id-filter=${"a".repeat(32)}`, `--zone-id-filter=${"b".repeat(32)}`]);
        // A single id sent as text works too.
        expect(externalDnsArgs(provider({ options: { zoneIds: "c".repeat(32) } }), OWNER, "rapidmx")).toContain(`--zone-id-filter=${"c".repeat(32)}`);
    });

    it("passes Route 53's zone type and role as flags (provider aws)", () => {
        const args = externalDnsArgs(
            provider({ type: "route53", options: { region: "eu-west-1", zoneType: "public", assumeRoleArn: "arn:aws:iam::123456789012:role/dns" } }),
            OWNER,
            "rapidmx"
        );
        expect(args).toEqual([
            ...commonArgs("p1", "aws", ["example.com"], ALL_KINDS),
            "--aws-zone-type=public",
            "--aws-assume-role=arn:aws:iam::123456789012:role/dns",
        ]);
    });

    it("passes rfc2136's servers, zone and TSIG settings, always with AXFR, and never MX or SRV", () => {
        const args = externalDnsArgs(
            provider({
                type: "rfc2136",
                options: { hosts: ["ns1.example.com", "2001:db8::53"], port: 5353, zone: "example.com", tsigKeyName: "rapidmx", tsigAlgorithm: "hmac-sha256", insecure: false },
            }),
            OWNER,
            "rapidmx"
        );
        expect(args).toEqual([
            ...commonArgs("p1", "rfc2136", ["example.com"], ["A", "AAAA", "CNAME", "TXT"]),
            "--rfc2136-host=ns1.example.com",
            "--rfc2136-host=2001:db8::53",
            "--rfc2136-port=5353",
            "--rfc2136-zone=example.com",
            "--rfc2136-tsig-keyname=rapidmx",
            "--rfc2136-tsig-secret-alg=hmac-sha256",
            "--rfc2136-axfr",
        ]);
        const insecure = externalDnsArgs(provider({ type: "rfc2136", options: { hosts: "ns1.example.com", zone: "example.com", insecure: true } }), OWNER, "rapidmx");
        expect(insecure.slice(-4)).toEqual(["--rfc2136-host=ns1.example.com", "--rfc2136-zone=example.com", "--rfc2136-insecure", "--rfc2136-axfr"]);
    });

    it("gives rfc2136 every zone of the config, its own zone first: external-dns lists and updates only the zones it is given", () => {
        const options = { hosts: ["ns1.example.com"], zone: "example.org", tsigKeyName: "rapidmx", tsigAlgorithm: "hmac-sha256" };
        const args = externalDnsArgs(provider({ type: "rfc2136", zones: ["example.com", "example.org", "example.net"], options }), OWNER, "rapidmx");
        expect(args.filter((arg) => arg.startsWith("--rfc2136-zone="))).toEqual(["--rfc2136-zone=example.org", "--rfc2136-zone=example.com", "--rfc2136-zone=example.net"]);
        expect(args.filter((arg) => arg.startsWith("--domain-filter="))).toHaveLength(3);
        // Without a zone option every zone of the config still is one.
        const bare = externalDnsArgs(provider({ type: "rfc2136", zones: ["example.com", "example.org"], options: { hosts: ["ns1.example.com"] } }), OWNER, "rapidmx");
        expect(bare.filter((arg) => arg.startsWith("--rfc2136-zone="))).toEqual(["--rfc2136-zone=example.com", "--rfc2136-zone=example.org"]);
    });

    it("passes Google's project and Azure's file, subscription and resource group", () => {
        expect(externalDnsArgs(provider({ type: "google", options: { project: "my-project" } }), OWNER, "rapidmx").slice(-1)).toEqual(["--google-project=my-project"]);
        expect(
            externalDnsArgs(
                provider({ type: "azure", options: { tenantId: "11111111-2222-3333-4444-555555555555", subscriptionId: "s", resourceGroup: "dns-rg" } }),
                OWNER,
                "rapidmx"
            ).slice(-3)
        ).toEqual(["--azure-config-file=/etc/external-dns/azure/azure.json", "--azure-subscription-id=s", "--azure-resource-group=dns-rg"]);
    });

    it("keeps an instance out of the zones other configs have nested under its own, right after its domain filters", () => {
        const parent = provider({ uid: "parent", zones: ["example.com", "example.org"] });
        const providers = [
            parent,
            provider({ uid: "sub", zones: ["sub.example.com", "other.net"] }),
            provider({ uid: "deeper", zones: ["a.sub.example.com", "sub.example.com"] }),
            // A name that merely ends the same way isn't under the zone.
            provider({ uid: "lookalike", zones: ["badexample.com"] }),
        ];
        expect(nestedZones(parent, providers)).toEqual(["sub.example.com", "a.sub.example.com"]);
        expect(nestedZones(providers[1], providers)).toEqual(["a.sub.example.com"]);
        expect(nestedZones(providers[3], providers)).toEqual([]);
        const args = externalDnsArgs(parent, OWNER, "rapidmx", nestedZones(parent, providers));
        expect(args.slice(6, 10)).toEqual([
            "--domain-filter=example.com",
            "--domain-filter=example.org",
            "--exclude-domains=sub.example.com",
            "--exclude-domains=a.sub.example.com",
        ]);
        const deployment = externalDnsDeployment(parent, OWNER, settings, undefined, ["sub.example.com"]);
        expect(container(deployment).args).toContain("--exclude-domains=sub.example.com");
    });

    it("also keeps an instance out of the zones of a deleted config whose instance still runs, those under its own zones or the same", () => {
        const parent = provider({ uid: "parent", zones: ["example.com"] });
        expect(nestedZones(parent, [parent], ["sub.example.com", "example.com", "other.net", "badexample.com"])).toEqual(["sub.example.com", "example.com"]);
        // Once, though a config has it too.
        const sub = provider({ uid: "sub", zones: ["sub.example.com"] });
        expect(nestedZones(parent, [parent, sub], ["sub.example.com"])).toEqual(["sub.example.com"]);
    });

    it("ignores options it doesn't know and options of the wrong shape", () => {
        const args = externalDnsArgs(provider({ type: "route53", options: { zoneType: 3, assumeRoleArn: ["x"], other: "y" } }), OWNER, "rapidmx");
        expect(args).toEqual(commonArgs("p1", "aws", ["example.com"], ALL_KINDS));
    });
});

describe("credentialsProblem", () => {
    it("names the credential fields a type needs and the reference doesn't have", () => {
        expect(credentialsProblem(cloudflare)).toBeUndefined();
        expect(credentialsProblem(provider({}))).toBe("missing credentials: apiToken");
        expect(credentialsProblem(provider({ type: "google" }))).toBe("missing credentials: serviceAccountJson");
        expect(
            credentialsProblem(provider({ type: "azure", credentials: { keys: ["clientId"], generation: 1 } }))
        ).toBe("missing credentials: clientSecret");
        expect(credentialsProblem(provider({ type: "rfc2136", options: { insecure: false } }))).toBe("missing credentials: tsigSecret");
    });

    it("needs none for Route 53 through IRSA or unsigned rfc2136", () => {
        expect(credentialsProblem(provider({ type: "route53" }))).toBeUndefined();
        expect(credentialsProblem(provider({ type: "rfc2136", options: { insecure: true } }))).toBeUndefined();
    });
});

describe("externalDnsDeployment", () => {
    it("is the golden Deployment for the fixture's Cloudflare config: pinned image, Recreate, hardened, credentials only by reference", () => {
        expect(externalDnsDeployment(cloudflare, OWNER, settings, 1)).toEqual({
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
                name: "mail-external-dns-cloudflare-main",
                namespace: "rapidmx",
                labels: {
                    "app.kubernetes.io/name": "external-dns",
                    "app.kubernetes.io/instance": "mail",
                    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                    "rapidmx.io/dns-provider": "cloudflare-main",
                },
            },
            spec: {
                replicas: 1,
                strategy: { type: "Recreate" },
                revisionHistoryLimit: 2,
                selector: {
                    matchLabels: {
                        "app.kubernetes.io/name": "external-dns",
                        "app.kubernetes.io/instance": "mail",
                        "rapidmx.io/dns-provider": "cloudflare-main",
                    },
                },
                template: {
                    metadata: {
                        labels: {
                            "app.kubernetes.io/name": "external-dns",
                            "app.kubernetes.io/instance": "mail",
                            "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                            "rapidmx.io/dns-provider": "cloudflare-main",
                        },
                        annotations: { "rapidmx.io/credentials-generation": "1" },
                    },
                    spec: {
                        serviceAccountName: "mail-external-dns",
                        securityContext: {
                            runAsNonRoot: true,
                            runAsUser: 65532,
                            runAsGroup: 65532,
                            fsGroup: 65532,
                            seccompProfile: { type: "RuntimeDefault" },
                        },
                        containers: [
                            {
                                name: "external-dns",
                                image: PIN,
                                args: [...commonArgs("cloudflare-main", "cloudflare", ["example.com"], ALL_KINDS), "--zone-id-filter=0123456789abcdef0123456789abcdef"],
                                env: [{ name: "CF_API_TOKEN", valueFrom: { secretKeyRef: { name: "mail-dns-cloudflare-main", key: "apiToken" } } }],
                                ports: [{ name: "http", containerPort: 7979, protocol: "TCP" }],
                                livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 },
                                readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 10, timeoutSeconds: 5 },
                                securityContext: {
                                    allowPrivilegeEscalation: false,
                                    readOnlyRootFilesystem: true,
                                    runAsNonRoot: true,
                                    capabilities: { drop: ["ALL"] },
                                },
                            },
                        ],
                    },
                },
            },
        });
    });

    it("is scaled to zero while the config is disabled or its credentials are incomplete", () => {
        const replicas = (d: ReturnType<typeof externalDnsDeployment>): number => (d as unknown as { spec: { replicas: number } }).spec.replicas;
        expect(replicas(externalDnsDeployment({ ...cloudflare, enabled: false }, OWNER, settings, 1))).toBe(0);
        expect(replicas(externalDnsDeployment(provider({}), OWNER, settings))).toBe(0);
    });

    it("carries the credentials generation it is given, and none without credentials", () => {
        const annotations = (d: ReturnType<typeof externalDnsDeployment>): unknown =>
            (d as unknown as { spec: { template: { metadata: { annotations?: unknown } } } }).spec.template.metadata.annotations;
        expect(annotations(externalDnsDeployment(cloudflare, OWNER, settings, 7))).toEqual({ "rapidmx.io/credentials-generation": "7" });
        expect(annotations(externalDnsDeployment(provider({ type: "route53" }), OWNER, settings))).toBeUndefined();
    });

    it("sets the configured resources", () => {
        const deployment = externalDnsDeployment(cloudflare, OWNER, { ...settings, externalDnsResources: { limits: { memory: "128Mi" } } }, 1);
        expect((container(deployment) as unknown as { resources: unknown }).resources).toEqual({ limits: { memory: "128Mi" } });
    });

    it("gives Route 53 its region and, only when both are saved, its access keys", () => {
        const keys = { keys: ["accessKeyId", "secretAccessKey"], generation: 2 };
        const withKeys = container(externalDnsDeployment(provider({ type: "route53", options: { region: "eu-west-1" }, credentials: keys }), OWNER, settings, 2));
        expect(withKeys.env).toEqual([
            { name: "AWS_REGION", value: "eu-west-1" },
            { name: "AWS_ACCESS_KEY_ID", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "accessKeyId" } } },
            { name: "AWS_SECRET_ACCESS_KEY", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "secretAccessKey" } } },
        ]);
        const irsa = container(externalDnsDeployment(provider({ type: "route53" }), OWNER, settings));
        expect(irsa.env).toBeUndefined();
    });

    it("gives rfc2136 its TSIG secret through EXTERNAL_DNS_RFC2136_TSIG_SECRET, never as an argument", () => {
        const ref = { keys: ["tsigSecret"], generation: 1 };
        const c = container(externalDnsDeployment(provider({ type: "rfc2136", options: { hosts: ["ns1"], zone: "example.com" }, credentials: ref }), OWNER, settings, 1));
        expect(c.env).toEqual([{ name: "EXTERNAL_DNS_RFC2136_TSIG_SECRET", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "tsigSecret" } } }]);
        expect(c.args.some((a) => a.startsWith("--rfc2136-tsig-secret="))).toBe(false);
    });

    it("mounts Google's key file and Azure's azure.json from the Secret, read-only", () => {
        const google = externalDnsDeployment(
            provider({ type: "google", options: { project: "x" }, credentials: { keys: ["serviceAccountJson"], generation: 1 } }),
            OWNER,
            settings,
            1
        );
        expect(container(google).env).toEqual([{ name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/etc/external-dns/google/credentials.json" }]);
        expect(container(google).volumeMounts).toEqual([{ name: "credentials", mountPath: "/etc/external-dns/google", readOnly: true }]);
        expect(podSpec(google).volumes).toEqual([
            { name: "credentials", secret: { secretName: "mail-dns-p1", items: [{ key: "serviceAccountJson", path: "credentials.json" }] } },
        ]);
        const azure = externalDnsDeployment(
            provider({ type: "azure", options: {}, credentials: { keys: ["clientId", "clientSecret"], generation: 1 } }),
            OWNER,
            settings,
            1
        );
        expect(container(azure).env).toBeUndefined();
        expect(podSpec(externalDnsDeployment(provider({ type: "azure" }), OWNER, settings)).volumes).toBeUndefined();
        expect(container(externalDnsDeployment(provider({ type: "google" }), OWNER, settings)).env).toBeUndefined();
        expect(container(azure).volumeMounts).toEqual([{ name: "credentials", mountPath: "/etc/external-dns/azure", readOnly: true }]);
        expect(podSpec(azure).volumes).toEqual([{ name: "credentials", secret: { secretName: "mail-dns-p1", items: [{ key: "azure.json", path: "azure.json" }] } }]);
    });
});

describe("credentialsSecret", () => {
    const OWNER_UID = "11111111-aaaa-bbbb-cccc-222222222222";
    const GUID = "11111111-2222-3333-4444-555555555555";
    const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

    it("is the provider's Secret: labelled, at the generation it holds, owned by the instance's Deployment, with the fields as data", () => {
        expect(credentialsSecret(cloudflare, { apiToken: "cf-token" }, settings, OWNER_UID)).toEqual({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: {
                name: "mail-dns-cloudflare-main",
                namespace: "rapidmx",
                labels: {
                    "app.kubernetes.io/instance": "mail",
                    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                    "rapidmx.io/dns-provider": "cloudflare-main",
                    "rapidmx.io/secret-kind": "dns",
                },
                annotations: { "rapidmx.io/credentials-generation": "1" },
                ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "mail-external-dns-cloudflare-main", uid: OWNER_UID }],
            },
            data: { apiToken: b64("cf-token") },
        });
    });

    it("holds the generation of the credentials it is given", () => {
        const secret = credentialsSecret({ ...cloudflare, credentials: { keys: ["apiToken"], generation: 9 } }, { apiToken: "x" }, settings, OWNER_UID);
        expect(secret.metadata.annotations).toEqual({ "rapidmx.io/credentials-generation": "9" });
    });

    it("keeps each type's own fields, in the form external-dns reads them, and leaves any other out", () => {
        const data = (type: DnsProviderV1["type"], values: Record<string, string>): unknown =>
            credentialsSecret(provider({ type, options: { tenantId: GUID }, credentials: { keys: Object.keys(values), generation: 1 } }), values, settings, OWNER_UID).data;
        expect(data("cloudflare", { apiToken: "t", other: "o" })).toEqual({ apiToken: b64("t") });
        expect(data("route53", { accessKeyId: "id", secretAccessKey: "key" })).toEqual({ accessKeyId: b64("id"), secretAccessKey: b64("key") });
        // A field the type reads that was not sent is not invented.
        expect(data("route53", { accessKeyId: "id" })).toEqual({ accessKeyId: b64("id") });
        expect(data("rfc2136", { tsigSecret: "c2VjcmV0" })).toEqual({ tsigSecret: b64("c2VjcmV0") });
        // A key file is multi-line text; it is stored as it came.
        const keyFile = '{\n  "type": "service_account"\n}';
        expect(data("google", { serviceAccountJson: keyFile })).toEqual({ serviceAccountJson: b64(keyFile) });
    });

    it("builds Azure's azure.json itself: the tenant from the options, the client from the credentials, JSON-encoded", () => {
        const azure = provider({ type: "azure", options: { tenantId: GUID }, credentials: { keys: ["clientId", "clientSecret"], generation: 3 } });
        // A quote, a backslash and a newline in the secret must come out as the same characters.
        const clientSecret = 'se"cr\\et\n';
        const secret = credentialsSecret(azure, { clientId: "client-1", clientSecret }, settings, OWNER_UID);
        expect(Object.keys(secret.data)).toEqual(["azure.json"]);
        expect(JSON.parse(Buffer.from(secret.data["azure.json"], "base64").toString("utf8"))).toEqual({
            tenantId: GUID,
            aadClientId: "client-1",
            aadClientSecret: clientSecret,
        });
        expect(secret.metadata.annotations).toEqual({ "rapidmx.io/credentials-generation": "3" });
    });

    it("writes no azure.json until both Azure client fields are there (the instance runs no replica then)", () => {
        const azure = provider({ type: "azure", options: { tenantId: GUID }, credentials: { keys: ["clientId"], generation: 1 } });
        expect(credentialsSecret(azure, { clientId: "client-1" }, settings, OWNER_UID).data).toEqual({});
        expect(credentialsSecret(azure, { clientSecret: "secret-1" }, settings, OWNER_UID).data).toEqual({});
    });

    it("refuses an Azure tenant that isn't a GUID", () => {
        for (const tenantId of ["{{ .clientSecret }}", "", undefined, GUID + "0", 5]) {
            const azure = provider({ type: "azure", options: tenantId === undefined ? {} : { tenantId }, credentials: { keys: ["clientId", "clientSecret"], generation: 1 } });
            expect(() => credentialsSecret(azure, { clientId: "a", clientSecret: "b" }, settings, OWNER_UID)).toThrow("'tenantId' must be a GUID");
        }
    });

    it("carries a value only as base64 data, never in the metadata", () => {
        const secret = credentialsSecret(cloudflare, { apiToken: "super-secret-token" }, settings, OWNER_UID);
        expect(JSON.stringify(secret.metadata)).not.toContain("super-secret-token");
    });
});

describe("dnsEndpoint", () => {
    const set: EndpointSetV1 = fixture.endpointSets[0];

    it("names it after the release and the set, labels it for the provider's instance and the domain", () => {
        expect(dnsEndpointName(settings, set.id)).toBe("mail-domain-example-com");
        expect(dnsEndpoint(set, "cloudflare", settings)).toEqual({
            apiVersion: "externaldns.k8s.io/v1alpha1",
            kind: "DNSEndpoint",
            metadata: {
                name: "mail-domain-example-com",
                namespace: "rapidmx",
                labels: {
                    "app.kubernetes.io/instance": "mail",
                    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                    "rapidmx.io/dns-provider": "cloudflare-main",
                    "rapidmx.io/domain": "example.com",
                },
            },
            spec: {
                endpoints: [
                    { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], recordTTL: 300 },
                    { dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ['"rapidmx-domain-verification=3f9c1d"'], recordTTL: 300 },
                ],
            },
        });
    });

    it("quotes every TXT target, keeps the others as sent, and leaves the TTL out when the server sends none", () => {
        const hosts: EndpointSetV1 = {
            id: "hosts-p1",
            providerUid: "p1",
            records: [
                { dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "keep-me"] },
                { dnsName: "_autodiscover._tcp.example.com", recordType: "SRV", targets: ["0 0 443 mail.example.com."], ttl: 60 },
            ],
        };
        const endpoints = (dnsEndpoint(hosts, "route53", settings) as unknown as { spec: { endpoints: unknown[] } }).spec.endpoints;
        expect(endpoints).toEqual([
            { dnsName: "example.com", recordType: "TXT", targets: ['"v=spf1 mx ~all"', '"keep-me"'] },
            { dnsName: "_autodiscover._tcp.example.com", recordType: "SRV", targets: ["0 0 443 mail.example.com."], recordTTL: 60 },
        ]);
        expect((dnsEndpoint(hosts, "route53", settings) as unknown as { metadata: { labels: Record<string, string> } }).metadata.labels).not.toHaveProperty(
            "rapidmx.io/domain"
        );
    });

    it("marks Cloudflare's A, AAAA and CNAME records unproxied", () => {
        const hosts: EndpointSetV1 = {
            id: "hosts-p1",
            providerUid: "p1",
            records: [
                { dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.5"], ttl: 120 },
                { dnsName: "mail.example.com", recordType: "AAAA", targets: ["2001:db8::5"], ttl: 120 },
                { dnsName: "auth.example.com", recordType: "CNAME", targets: ["mail.example.com"], ttl: 120 },
                { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 120 },
            ],
        };
        const endpoints = (dnsEndpoint(hosts, "cloudflare", settings) as unknown as { spec: { endpoints: { recordType: string; providerSpecific?: unknown }[] } }).spec
            .endpoints;
        const unproxied = [{ name: "cloudflare/proxied", value: "false" }];
        expect(endpoints.map((e) => [e.recordType, e.providerSpecific])).toEqual([
            ["A", unproxied],
            ["AAAA", unproxied],
            ["CNAME", unproxied],
            ["MX", undefined],
        ]);
    });

    it("leaves MX, SRV and the TXT values it can't round-trip out of an rfc2136 endpoint, which that provider can't keep", () => {
        const records: EndpointSetV1["records"] = [
            { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"] },
            { dnsName: "_autodiscover._tcp.example.com", recordType: "SRV", targets: ["0 0 443 mail.example.com."] },
            { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"] },
            { dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"] },
        ];
        const endpoints = (dnsEndpoint({ ...set, records }, "rfc2136", settings) as unknown as { spec: { endpoints: unknown[] } }).spec.endpoints;
        expect(endpoints).toEqual([{ dnsName: "_rapidmx-verify.example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"] }]);
    });

    it("writes Azure's TXT values unquoted and leaves out a TXT set of several values, which Azure can't keep", () => {
        const records: EndpointSetV1["records"] = [
            { dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "keep-me"] },
            { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"], ttl: 300 },
            { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 },
        ];
        const endpoints = (dnsEndpoint({ ...set, records }, "azure", settings) as unknown as { spec: { endpoints: unknown[] } }).spec.endpoints;
        expect(endpoints).toEqual([
            { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none;"], recordTTL: 300 },
            { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], recordTTL: 300 },
        ]);
    });

    it("leaves out a domain label a domain name too long for a label value can't be", () => {
        const long = `${"a".repeat(60)}.example.com`;
        const labels = (dnsEndpoint({ ...set, domainUid: long }, "cloudflare", settings) as unknown as { metadata: { labels: Record<string, string> } }).metadata.labels;
        expect(labels).not.toHaveProperty("rapidmx.io/domain");
    });

    it("never carries the registry's ownership records: external-dns writes those itself", () => {
        const text = JSON.stringify(fixture.endpointSets.map((s) => dnsEndpoint(s, "cloudflare", settings)));
        expect(text).not.toContain("rmx-");
        expect(text).not.toContain("heritage=");
    });
});

describe("operationName", () => {
    it("is the release's name with a hash of the operation id, so any id makes a valid, bounded name", () => {
        expect(operationName(settings, "op-1")).toBe("mail-op-71a0ef7195df4865");
        expect(operationName(settings, "3f6c0a1e-9b1d-4f43-8a52-0c2d6f7e1a11")).toBe("mail-op-30d743a1ef714297");
        // An id no label could hold is still a name.
        expect(operationName(settings, "Ö/ id with spaces")).toMatch(/^mail-op-[0-9a-f]{16}$/);
        // A Job name is at most 63 characters: a long release name is cut, never ending in a hyphen.
        const long = operationName({ fullname: `${"a".repeat(39)}-${"b".repeat(23)}` }, "op-1");
        expect(long).toBe(`${"a".repeat(39)}-op-71a0ef7195df4865`);
        expect(long.length).toBeLessThanOrEqual(63);
    });
});

describe("isOurSecret", () => {
    it("holds a Secret to three labels: this controller, the dns kind and the provider", () => {
        const labels = {
            "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
            "rapidmx.io/secret-kind": "dns",
            "rapidmx.io/dns-provider": "p1",
        };
        expect(isOurSecret(labels, "p1")).toBe(true);
        expect(isOurSecret(labels, "p2")).toBe(false);
        expect(isOurSecret({ ...labels, "rapidmx.io/secret-kind": "other" }, "p1")).toBe(false);
        expect(isOurSecret({ ...labels, "app.kubernetes.io/managed-by": "helm" }, "p1")).toBe(false);
        expect(isOurSecret(undefined, "p1")).toBe(false);
    });
});

const HASH = "71a0ef7195df4865";

function operation(patch: Partial<OperationV1>): OperationV1 {
    return { id: "op-1", type: "takeover", providerUid: "cloudflare-main", endpointSetId: "domain-example-com", ...patch };
}

/** The records a takeover or a restore writes, as the server sends them: TXT values unquoted. */
const RECORDS: OperationV1["records"] = [
    { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 },
    { dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "keep me"], ttl: 300 },
];

type JobSpec = {
    metadata: { name: string; namespace: string; labels: Record<string, string>; annotations: Record<string, string> };
    spec: {
        backoffLimit: number;
        activeDeadlineSeconds: number;
        template: {
            metadata: { labels: Record<string, string> };
            spec: { restartPolicy: string; serviceAccountName: string; containers: (Container & Record<string, unknown>)[] } & Record<string, unknown>;
        };
    };
};
const job = (op: OperationV1, p: DnsProviderV1 = cloudflare, excluded: string[] = []): JobSpec => operationJob(op, p, settings, excluded) as unknown as JobSpec;
const jobContainer = (j: JobSpec): Container & Record<string, unknown> => j.spec.template.spec.containers[0];

/** The arguments every operation Job has, in order, before the provider-specific ones (spec 9.3). */
function jobArgs(type: string, zones: string[], kinds: string[], rest: string[]): string[] {
    return [
        "--source=crd",
        "--crd-source-apiversion=externaldns.k8s.io/v1alpha1",
        "--crd-source-kind=DNSEndpoint",
        "--namespace=rapidmx",
        `--label-filter=rapidmx.io/dns-operation=${HASH}`,
        `--provider=${type}`,
        ...zones.map((zone) => `--domain-filter=${zone}`),
        "--registry=noop",
        "--policy=upsert-only",
        ...kinds.map((kind) => `--managed-record-types=${kind}`),
        ...rest,
    ];
}

describe("operationJob", () => {
    it("is the golden one-shot Job of a takeover: the pinned image, the noop registry, upsert only, once, selecting only its own endpoint", () => {
        expect(operationJob(operation({}), cloudflare, settings, [])).toEqual({
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
                name: `mail-op-${HASH}`,
                namespace: "rapidmx",
                labels: {
                    "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                    "app.kubernetes.io/instance": "mail",
                    "rapidmx.io/dns-operation": HASH,
                },
                annotations: { "rapidmx.io/dns-operation-id": "op-1" },
            },
            spec: {
                backoffLimit: 0,
                activeDeadlineSeconds: 300,
                template: {
                    metadata: {
                        labels: {
                            "app.kubernetes.io/name": "external-dns-operation",
                            "app.kubernetes.io/instance": "mail",
                            "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                            "rapidmx.io/dns-operation": HASH,
                        },
                    },
                    spec: {
                        restartPolicy: "Never",
                        serviceAccountName: "mail-external-dns",
                        securityContext: {
                            runAsNonRoot: true,
                            runAsUser: 65532,
                            runAsGroup: 65532,
                            fsGroup: 65532,
                            seccompProfile: { type: "RuntimeDefault" },
                        },
                        containers: [
                            {
                                name: "external-dns",
                                image: PIN,
                                args: [...jobArgs("cloudflare", ["example.com"], ALL_KINDS, ["--once", "--log-format=json"]), "--zone-id-filter=0123456789abcdef0123456789abcdef"],
                                env: [{ name: "CF_API_TOKEN", valueFrom: { secretKeyRef: { name: "mail-dns-cloudflare-main", key: "apiToken" } } }],
                                // The last log lines become the pod's termination message when it fails: the reason reported back.
                                terminationMessagePolicy: "FallbackToLogsOnError",
                                securityContext: {
                                    allowPrivilegeEscalation: false,
                                    readOnlyRootFilesystem: true,
                                    runAsNonRoot: true,
                                    capabilities: { drop: ["ALL"] },
                                },
                            },
                        ],
                    },
                },
            },
        });
    });

    it("tests the credentials with a dry run: the same Job with --dry-run, which a takeover or a restore never has", () => {
        expect(jobContainer(job(operation({ type: "test", endpointSetId: undefined }))).args).toEqual([
            ...jobArgs("cloudflare", ["example.com"], ALL_KINDS, ["--once", "--dry-run", "--log-format=json"]),
            "--zone-id-filter=0123456789abcdef0123456789abcdef",
        ]);
        for (const type of ["takeover", "restore"] as const) {
            expect(jobContainer(job(operation({ type }))).args).not.toContain("--dry-run");
            expect(jobContainer(job(operation({ type }))).args).toContain("--once");
        }
    });

    it("never touches the regular instance's endpoints or registry: no provider label, no owner id, no sync policy", () => {
        const j = job(operation({}));
        const text = JSON.stringify(j);
        // The regular instance selects rapidmx.io/dns-provider=<uid>; neither the Job nor its pods carry it, so no Deployment's selector matches them.
        expect(text).not.toContain("rapidmx.io/dns-provider");
        expect(text).not.toContain("--txt-owner-id");
        expect(text).not.toContain("--policy=sync");
        expect(text).not.toContain("--registry=txt");
        expect(text).not.toContain("--events");
        expect(jobContainer(j)).not.toHaveProperty("ports");
        expect(jobContainer(j)).not.toHaveProperty("livenessProbe");
    });

    it("takes the provider's arguments and credentials like its instance, by reference only", () => {
        const route53 = provider({ uid: "r53", type: "route53", options: { region: "us-east-1", zoneType: "public" }, credentials: { keys: ["accessKeyId", "secretAccessKey"], generation: 2 } });
        const j = job(operation({ providerUid: "r53" }), route53);
        expect(jobContainer(j).args).toEqual(
            expect.arrayContaining(["--provider=aws", "--domain-filter=example.com", "--aws-zone-type=public", "--registry=noop", "--policy=upsert-only"])
        );
        expect(jobContainer(j).env).toEqual([
            { name: "AWS_REGION", value: "us-east-1" },
            { name: "AWS_ACCESS_KEY_ID", valueFrom: { secretKeyRef: { name: "mail-dns-r53", key: "accessKeyId" } } },
            { name: "AWS_SECRET_ACCESS_KEY", valueFrom: { secretKeyRef: { name: "mail-dns-r53", key: "secretAccessKey" } } },
        ]);
        // rfc2136 manages no MX or SRV, in a Job as in its instance.
        expect(jobContainer(job(operation({}), provider({ type: "rfc2136", options: { hosts: ["ns1.example.com"] } }))).args).toEqual(
            expect.arrayContaining(["--managed-record-types=TXT", "--rfc2136-axfr"])
        );
        expect(jobContainer(job(operation({}), provider({ type: "rfc2136" }))).args).not.toContain("--managed-record-types=MX");
    });

    it("mounts Google's key from the Secret, read-only, like its instance, and has no volumes without a credential file", () => {
        const google = job(operation({}), provider({ type: "google", options: { project: "p" }, credentials: { keys: ["serviceAccountJson"], generation: 1 } }));
        expect(google.spec.template.spec.volumes).toEqual([{ name: "credentials", secret: { secretName: "mail-dns-p1", items: [{ key: "serviceAccountJson", path: "credentials.json" }] } }]);
        expect(jobContainer(google).volumeMounts).toEqual([{ name: "credentials", mountPath: "/etc/external-dns/google", readOnly: true }]);
        expect(job(operation({})).spec.template.spec).not.toHaveProperty("volumes");
    });

    it("keeps its provider out of the nested zones of other configs and sets the configured resources", () => {
        const args = jobContainer(job(operation({}), cloudflare, ["sub.example.com"])).args;
        expect(args).toContain("--exclude-domains=sub.example.com");
        expect(args.indexOf("--exclude-domains=sub.example.com")).toBe(args.indexOf("--domain-filter=example.com") + 1);
        const resources = { limits: { memory: "64Mi" } };
        expect(jobContainer(operationJob(operation({}), cloudflare, { ...settings, externalDnsResources: resources }, []) as unknown as JobSpec).resources).toEqual(resources);
        expect(jobContainer(job(operation({})))).not.toHaveProperty("resources");
    });

    it("carries no credential value, only the names of the Secret and its keys", () => {
        expect(JSON.stringify(job(operation({})))).not.toContain("cf-example-token");
    });
});

describe("operationEndpoint", () => {
    type Entry = { dnsName: string; recordType: string; targets: string[]; recordTTL?: number };
    const entries = (m: ReturnType<typeof operationEndpoint>): Entry[] => (m as unknown as { spec: { endpoints: Entry[] } }).spec.endpoints;
    const owned = (regular: string): string => `"heritage=external-dns,external-dns/owner=${OWNER},external-dns/resource=crd/rapidmx/${regular}"`;

    it("is a takeover's temporary endpoint: the wanted records in the provider's form, then the ownership record of each name and type, without a TTL", () => {
        const endpoint = operationEndpoint(operation({ records: RECORDS }), "cloudflare", OWNER, settings);
        expect(endpoint).toMatchObject({
            apiVersion: "externaldns.k8s.io/v1alpha1",
            kind: "DNSEndpoint",
            metadata: {
                name: `mail-op-${HASH}`,
                namespace: "rapidmx",
                // Selected by the Job's label filter alone: never by an instance's, and never pruned as a regular endpoint.
                labels: { "app.kubernetes.io/managed-by": "rapidmx-dns-controller", "app.kubernetes.io/instance": "mail", "rapidmx.io/dns-operation": HASH },
            },
        });
        expect(JSON.stringify(endpoint)).not.toContain("rapidmx.io/dns-provider");
        expect(entries(endpoint)).toEqual([
            { dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], recordTTL: 300 },
            { dnsName: "example.com", recordType: "TXT", targets: ['"v=spf1 mx ~all"', '"keep me"'], recordTTL: 300 },
            { dnsName: "rmx-mx.example.com", recordType: "TXT", targets: [owned("mail-domain-example-com")] },
            { dnsName: "rmx-txt.example.com", recordType: "TXT", targets: [owned("mail-domain-example-com")] },
        ]);
    });

    it("names the regular endpoint of the set as the ownership records' resource, so the regular instance sees no change", () => {
        const endpoint = operationEndpoint(operation({ records: RECORDS, endpointSetId: "hosts-cloudflare-main" }), "cloudflare", OWNER, settings);
        expect(entries(endpoint)[2].targets[0]).toContain("external-dns/resource=crd/rapidmx/mail-hosts-cloudflare-main");
    });

    it("writes one ownership record per name and type, however many records share them", () => {
        const twice: OperationV1["records"] = [
            { dnsName: "example.com", recordType: "TXT", targets: ["a"] },
            { dnsName: "example.com", recordType: "TXT", targets: ["b"] },
            { dnsName: "_dmarc.example.com", recordType: "TXT", targets: ["v=DMARC1; p=none"] },
        ];
        const names = entries(operationEndpoint(operation({ records: twice }), "cloudflare", OWNER, settings)).map((e) => e.dnsName);
        expect(names).toEqual(["example.com", "example.com", "_dmarc.example.com", "rmx-txt.example.com", "rmx-txt._dmarc.example.com"]);
    });

    it("is a restore's: only the SPF and the kept values, quoted, and no ownership record, so the restored set is unowned again", () => {
        const restore = operation({ type: "restore", records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "keep me"], ttl: 300 }] });
        const endpoint = operationEndpoint(restore, "cloudflare", OWNER, settings);
        expect(entries(endpoint)).toEqual([{ dnsName: "example.com", recordType: "TXT", targets: ['"v=spf1 mx ~all"', '"keep me"'], recordTTL: 300 }]);
        expect(JSON.stringify(endpoint)).not.toContain("rmx-");
        expect(JSON.stringify(endpoint)).not.toContain("heritage=");
    });

    it("leaves out what the provider can't keep, and its ownership record with it", () => {
        // No MX on rfc2136, and an SPF value with spaces can't be kept there.
        expect(entries(operationEndpoint(operation({ records: RECORDS }), "rfc2136", OWNER, settings))).toEqual([]);
        const plain = operation({ records: [{ dnsName: "example.com", recordType: "TXT", targets: ["rapidmx-domain-verification=3f9c1d"] }] });
        expect(entries(operationEndpoint(plain, "rfc2136", OWNER, settings)).map((e) => e.dnsName)).toEqual(["example.com", "rmx-txt.example.com"]);
    });

    it("marks Cloudflare's hosts unproxied, like the regular endpoint", () => {
        const host = operation({ records: [{ dnsName: "mail.example.com", recordType: "A", targets: ["203.0.113.5"] }] });
        expect(entries(operationEndpoint(host, "cloudflare", OWNER, settings))[0]).toMatchObject({ providerSpecific: [{ name: "cloudflare/proxied", value: "false" }] });
    });

    it("refuses a takeover that names no endpoint set, whose ownership records it could not write", () => {
        expect(() => operationEndpoint(operation({ records: RECORDS, endpointSetId: undefined }), "cloudflare", OWNER, settings)).toThrow("endpoint set");
    });

    it("has no records for an operation that carries none", () => {
        expect(entries(operationEndpoint(operation({ type: "test" }), "cloudflare", OWNER, settings))).toEqual([]);
    });
});
