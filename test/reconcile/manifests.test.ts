import { readFileSync } from "node:fs";
import { parseDesiredState, type DesiredStateV1, type DnsProviderV1, type EndpointSetV1 } from "../../src/api/v1.js";
import {
    acceptsExternalDnsImage,
    credentialsProblem,
    dnsEndpoint,
    dnsEndpointName,
    externalDnsArgs,
    externalDnsDeployment,
    externalSecret,
    managedRecordKinds,
    nestedZones,
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

const withOpenbao: ManifestSettings = {
    ...settings,
    openbao: { secretStore: "mail-openbao", pathPrefix: "mail/integrations", externalSecretsApiVersion: "external-secrets.io/v1" },
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
            credentialsProblem(provider({ type: "azure", secretRef: { backend: "kubernetes", path: "dns/p1", keys: ["clientId"], generation: 1 } }))
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
        const keys = { backend: "kubernetes" as const, path: "dns/p1", keys: ["accessKeyId", "secretAccessKey"], generation: 2 };
        const withKeys = container(externalDnsDeployment(provider({ type: "route53", options: { region: "eu-west-1" }, secretRef: keys }), OWNER, settings, 2));
        expect(withKeys.env).toEqual([
            { name: "AWS_REGION", value: "eu-west-1" },
            { name: "AWS_ACCESS_KEY_ID", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "accessKeyId" } } },
            { name: "AWS_SECRET_ACCESS_KEY", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "secretAccessKey" } } },
        ]);
        const irsa = container(externalDnsDeployment(provider({ type: "route53" }), OWNER, settings));
        expect(irsa.env).toBeUndefined();
    });

    it("gives rfc2136 its TSIG secret through EXTERNAL_DNS_RFC2136_TSIG_SECRET, never as an argument", () => {
        const ref = { backend: "openbao" as const, path: "dns/p1", keys: ["tsigSecret"], generation: 1 };
        const c = container(externalDnsDeployment(provider({ type: "rfc2136", options: { hosts: ["ns1"], zone: "example.com" }, secretRef: ref }), OWNER, settings, 1));
        expect(c.env).toEqual([{ name: "EXTERNAL_DNS_RFC2136_TSIG_SECRET", valueFrom: { secretKeyRef: { name: "mail-dns-p1", key: "tsigSecret" } } }]);
        expect(c.args.some((a) => a.startsWith("--rfc2136-tsig-secret="))).toBe(false);
    });

    it("mounts Google's key file and Azure's azure.json from the Secret, read-only", () => {
        const google = externalDnsDeployment(
            provider({ type: "google", options: { project: "x" }, secretRef: { backend: "kubernetes", path: "dns/p1", keys: ["serviceAccountJson"], generation: 1 } }),
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
            provider({ type: "azure", options: {}, secretRef: { backend: "openbao", path: "dns/p1", keys: ["clientId", "clientSecret"], generation: 1 } }),
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

describe("externalSecret", () => {
    it("has External Secrets materialize the provider's Secret from its OpenBao path, labelled, with the generation", () => {
        expect(externalSecret(cloudflare, withOpenbao)).toEqual({
            apiVersion: "external-secrets.io/v1",
            kind: "ExternalSecret",
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
            },
            spec: {
                refreshInterval: "1h",
                secretStoreRef: { name: "mail-openbao", kind: "SecretStore" },
                target: {
                    name: "mail-dns-cloudflare-main",
                    creationPolicy: "Owner",
                    template: {
                        metadata: {
                            labels: {
                                "app.kubernetes.io/instance": "mail",
                                "app.kubernetes.io/managed-by": "rapidmx-dns-controller",
                                "rapidmx.io/dns-provider": "cloudflare-main",
                                "rapidmx.io/secret-kind": "dns",
                            },
                            annotations: { "rapidmx.io/credentials-generation": "1" },
                        },
                    },
                },
                data: [{ secretKey: "apiToken", remoteRef: { key: "mail/integrations/dns/cloudflare-main", property: "apiToken" } }],
            },
        });
    });

    it("builds Azure's azure.json in the template, the tenant from the options and the client from the vault", () => {
        const azure = provider({
            type: "azure",
            options: { tenantId: "11111111-2222-3333-4444-555555555555" },
            secretRef: { backend: "openbao", path: "dns/p1", keys: ["clientId", "clientSecret"], generation: 3 },
        });
        const spec = (externalSecret(azure, withOpenbao) as unknown as { spec: { target: { template: { data: Record<string, string> } } } }).spec;
        expect(spec.target.template.data).toEqual({
            "azure.json":
                '{"tenantId":"11111111-2222-3333-4444-555555555555","aadClientId":{{ .clientId | toJson }},"aadClientSecret":{{ .clientSecret | toJson }}}',
        });
    });

    it("refuses an Azure tenant that isn't a GUID, since it is written into a template", () => {
        const azure = provider({ type: "azure", options: { tenantId: "{{ .clientSecret }}" }, secretRef: { backend: "openbao", path: "dns/p1", keys: ["clientId"], generation: 1 } });
        expect(() => externalSecret(azure, withOpenbao)).toThrow("'tenantId' must be a GUID");
    });

    it("is none for a config without OpenBao credentials", () => {
        expect(externalSecret(provider({ type: "route53" }), withOpenbao)).toBeUndefined();
        expect(externalSecret(provider({ secretRef: { backend: "kubernetes", path: "dns/p1", keys: ["apiToken"], generation: 1 } }), withOpenbao)).toBeUndefined();
    });

    it("refuses an OpenBao reference when the controller has no SecretStore configured", () => {
        expect(() => externalSecret(cloudflare, settings)).toThrow("OpenBao is not configured");
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
