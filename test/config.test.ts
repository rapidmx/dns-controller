import { ConfigError, DEFAULT_SERVER_TOKEN_FILE, DEFAULT_SERVICE_ACCOUNT_DIR, loadConfig } from "../src/config.js";

const base = {
    DNS_CONTROLLER_SERVER_URL: "http://mail.rapidmx.svc:3000/internal/dns/",
    DNS_CONTROLLER_LEASE_NAME: "mail-dns-controller",
    KUBERNETES_SERVICE_HOST: "10.43.0.1",
    HOSTNAME: "mail-dns-controller-abc",
    DNS_CONTROLLER_FULLNAME: "mail",
    DNS_CONTROLLER_RELEASE: "mail",
};

describe("loadConfig", () => {
    it("applies the defaults and trims a trailing slash from the server URL", () => {
        expect(loadConfig(base)).toEqual({
            serverUrl: "http://mail.rapidmx.svc:3000/internal/dns",
            serverTokenFile: DEFAULT_SERVER_TOKEN_FILE,
            serverTimeoutMs: 10000,
            handshakeRetrySeconds: 60,
            longPollTimeoutSeconds: 75,
            statusIntervalSeconds: 60,
            kubernetesHost: "10.43.0.1",
            kubernetesPort: "443",
            serviceAccountDir: DEFAULT_SERVICE_ACCOUNT_DIR,
            leaseName: "mail-dns-controller",
            holderIdentity: "mail-dns-controller-abc",
            leaseDurationSeconds: 30,
            renewIntervalSeconds: 10,
            healthPort: 8081,
            logLevel: "info",
            fullname: "mail",
            release: "mail",
            externalDnsImage: "registry.k8s.io/external-dns/external-dns:v0.23.0",
            externalDnsServiceAccount: "mail-external-dns",
            resyncMinutes: 10,
        });
    });

    it("reads the external-dns settings", () => {
        const pin = "registry.k8s.io/external-dns/external-dns:v0.23.0@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        expect(
            loadConfig({
                ...base,
                DNS_CONTROLLER_FULLNAME: " rel-rapidmx ",
                DNS_CONTROLLER_RELEASE: "rel",
                DNS_CONTROLLER_EXTERNAL_DNS_IMAGE: pin,
                DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT: "dns-sa",
                DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES: '{"requests":{"cpu":"10m"},"limits":{"memory":"128Mi"}}',
                DNS_CONTROLLER_RESYNC_MINUTES: "5",
            })
        ).toMatchObject({
            fullname: "rel-rapidmx",
            release: "rel",
            externalDnsImage: pin,
            externalDnsServiceAccount: "dns-sa",
            externalDnsResources: { requests: { cpu: "10m" }, limits: { memory: "128Mi" } },
            resyncMinutes: 5,
        });
    });

    it("ignores the OpenBao and External Secrets settings of the ExternalSecret path, which no longer exists", () => {
        const config = loadConfig({
            ...base,
            DNS_CONTROLLER_OPENBAO_SECRET_STORE: "mail-openbao",
            DNS_CONTROLLER_OPENBAO_PATH_PREFIX: "mail/integrations",
            DNS_CONTROLLER_EXTERNAL_SECRETS_API_VERSION: "external-secrets.io/v1beta1",
        });
        expect(config).not.toHaveProperty("openbao");
        // Not even a malformed old value stops a controller whose chart still sets them.
        expect(() => loadConfig({ ...base, DNS_CONTROLLER_OPENBAO_SECRET_STORE: "Bad Store", DNS_CONTROLLER_EXTERNAL_SECRETS_API_VERSION: "v2" })).not.toThrow();
        expect(loadConfig(base)).toEqual(loadConfig({ ...base, DNS_CONTROLLER_OPENBAO_PATH_PREFIX: "x" }));
    });

    it("reads every override", () => {
        const config = loadConfig({
            ...base,
            DNS_CONTROLLER_SERVER_URL: "https://mail.example.com/internal/dns",
            DNS_CONTROLLER_SERVER_TOKEN_FILE: "/tok",
            DNS_CONTROLLER_SERVER_TIMEOUT_MS: "5000",
            DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS: "5",
            DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS: "120",
            DNS_CONTROLLER_STATUS_INTERVAL_SECONDS: "30",
            KUBERNETES_SERVICE_PORT: "6443",
            DNS_CONTROLLER_SERVICE_ACCOUNT_DIR: "/sa",
            POD_NAME: "pod-1",
            DNS_CONTROLLER_LEASE_DURATION_SECONDS: "60",
            DNS_CONTROLLER_LEASE_RENEW_SECONDS: "20",
            DNS_CONTROLLER_HEALTH_PORT: "9000",
            DNS_CONTROLLER_LOG_LEVEL: "DEBUG",
        });
        expect(config).toMatchObject({
            serverUrl: "https://mail.example.com/internal/dns",
            serverTokenFile: "/tok",
            serverTimeoutMs: 5000,
            handshakeRetrySeconds: 5,
            longPollTimeoutSeconds: 120,
            statusIntervalSeconds: 30,
            kubernetesPort: "6443",
            serviceAccountDir: "/sa",
            holderIdentity: "pod-1",
            leaseDurationSeconds: 60,
            renewIntervalSeconds: 20,
            healthPort: 9000,
            logLevel: "debug",
        });
    });

    it("has no internal API settings: the controller serves only its health port, so the old ones are ignored", () => {
        const config = loadConfig({
            ...base,
            DNS_CONTROLLER_SERVER_SUBJECT: "not even a subject",
            DNS_CONTROLLER_API_AUDIENCE: "custom-audience",
            DNS_CONTROLLER_API_PORT: "not a port",
        });
        expect(config).toEqual(loadConfig(base));
        for (const key of ["serverSubject", "apiAudience", "apiPort"]) {
            expect(config).not.toHaveProperty(key);
        }
    });

    it("prefers POD_NAME and does not need HOSTNAME then", () => {
        const { HOSTNAME: _unused, ...rest } = base;
        expect(loadConfig({ ...rest, POD_NAME: " pod-2 " }).holderIdentity).toBe("pod-2");
    });

    it("treats blank values as unset", () => {
        expect(loadConfig({ ...base, DNS_CONTROLLER_HEALTH_PORT: "  ", DNS_CONTROLLER_LOG_LEVEL: "" })).toMatchObject({
            healthPort: 8081,
            logLevel: "info",
        });
    });

    it.each([
        ["DNS_CONTROLLER_SERVER_URL", { DNS_CONTROLLER_SERVER_URL: "" }, /DNS_CONTROLLER_SERVER_URL must be set/],
        ["DNS_CONTROLLER_SERVER_URL", { DNS_CONTROLLER_SERVER_URL: "not a url" }, /absolute URL/],
        ["DNS_CONTROLLER_SERVER_URL", { DNS_CONTROLLER_SERVER_URL: "ftp://x/y" }, /http or https/],
        ["DNS_CONTROLLER_LEASE_NAME", { DNS_CONTROLLER_LEASE_NAME: undefined }, /LEASE_NAME must be set/],
        ["KUBERNETES_SERVICE_HOST", { KUBERNETES_SERVICE_HOST: undefined }, /KUBERNETES_SERVICE_HOST must be set/],
        ["HOSTNAME", { HOSTNAME: undefined }, /HOSTNAME must be set/],
        ["DNS_CONTROLLER_HEALTH_PORT", { DNS_CONTROLLER_HEALTH_PORT: "0" }, /from 1 to 65535/],
        ["DNS_CONTROLLER_HEALTH_PORT", { DNS_CONTROLLER_HEALTH_PORT: "80.5" }, /whole number/],
        ["DNS_CONTROLLER_HEALTH_PORT", { DNS_CONTROLLER_HEALTH_PORT: "abc" }, /whole number/],
        ["DNS_CONTROLLER_LEASE_DURATION_SECONDS", { DNS_CONTROLLER_LEASE_DURATION_SECONDS: "1000" }, /from 5 to 300/],
        ["DNS_CONTROLLER_LEASE_RENEW_SECONDS", { DNS_CONTROLLER_LEASE_RENEW_SECONDS: "11" }, /at most a third/],
        ["DNS_CONTROLLER_LOG_LEVEL", { DNS_CONTROLLER_LOG_LEVEL: "verbose" }, /one of debug, info, warn, error/],
        ["DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS", { DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS: "5" }, /from 10 to 900/],
        ["DNS_CONTROLLER_STATUS_INTERVAL_SECONDS", { DNS_CONTROLLER_STATUS_INTERVAL_SECONDS: "1" }, /from 5 to 3600/],
        ["DNS_CONTROLLER_FULLNAME", { DNS_CONTROLLER_FULLNAME: undefined }, /DNS_CONTROLLER_FULLNAME must be set/],
        ["DNS_CONTROLLER_FULLNAME", { DNS_CONTROLLER_FULLNAME: "Mail_Server" }, /DNS_CONTROLLER_FULLNAME must be a Kubernetes name/],
        ["DNS_CONTROLLER_FULLNAME", { DNS_CONTROLLER_FULLNAME: "a".repeat(64) }, /DNS_CONTROLLER_FULLNAME must be a Kubernetes name/],
        ["DNS_CONTROLLER_RELEASE", { DNS_CONTROLLER_RELEASE: undefined }, /DNS_CONTROLLER_RELEASE must be set/],
        ["DNS_CONTROLLER_RELEASE", { DNS_CONTROLLER_RELEASE: "rel/x" }, /DNS_CONTROLLER_RELEASE must be a label value/],
        ["DNS_CONTROLLER_EXTERNAL_DNS_IMAGE", { DNS_CONTROLLER_EXTERNAL_DNS_IMAGE: "two words" }, /DNS_CONTROLLER_EXTERNAL_DNS_IMAGE must be an image reference/],
        ["DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT", { DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT: "No" }, /must be a Kubernetes name/],
        ["DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES", { DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES: "[1]" }, /must be a JSON object/],
        ["DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES", { DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES: "{" }, /must be a JSON object/],
        ["DNS_CONTROLLER_RESYNC_MINUTES", { DNS_CONTROLLER_RESYNC_MINUTES: "0" }, /from 1 to 1440/],
    ])("refuses a bad %s", (_name, patch, message) => {
        expect(() => loadConfig({ ...base, ...patch })).toThrow(ConfigError);
        expect(() => loadConfig({ ...base, ...patch })).toThrow(message);
    });

    it("reads process.env by default", () => {
        const saved = { ...process.env };
        try {
            Object.assign(process.env, base);
            expect(loadConfig().leaseName).toBe("mail-dns-controller");
        } finally {
            process.env = saved;
        }
    });
});
