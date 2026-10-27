import { ConfigError, DEFAULT_SERVER_TOKEN_FILE, DEFAULT_SERVICE_ACCOUNT_DIR, loadConfig } from "../src/config.js";

const base = {
    DNS_CONTROLLER_SERVER_URL: "http://mail.rapidmx.svc:3000/internal/dns/",
    DNS_CONTROLLER_LEASE_NAME: "mail-dns-controller",
    KUBERNETES_SERVICE_HOST: "10.43.0.1",
    HOSTNAME: "mail-dns-controller-abc",
};

describe("loadConfig", () => {
    it("applies the defaults and trims a trailing slash from the server URL", () => {
        expect(loadConfig(base)).toEqual({
            serverUrl: "http://mail.rapidmx.svc:3000/internal/dns",
            serverTokenFile: DEFAULT_SERVER_TOKEN_FILE,
            serverTimeoutMs: 10000,
            handshakeRetrySeconds: 60,
            kubernetesHost: "10.43.0.1",
            kubernetesPort: "443",
            serviceAccountDir: DEFAULT_SERVICE_ACCOUNT_DIR,
            leaseName: "mail-dns-controller",
            holderIdentity: "mail-dns-controller-abc",
            leaseDurationSeconds: 30,
            renewIntervalSeconds: 10,
            healthPort: 8081,
            logLevel: "info",
        });
    });

    it("reads every override", () => {
        const config = loadConfig({
            ...base,
            DNS_CONTROLLER_SERVER_URL: "https://mail.example.com/internal/dns",
            DNS_CONTROLLER_SERVER_TOKEN_FILE: "/tok",
            DNS_CONTROLLER_SERVER_TIMEOUT_MS: "5000",
            DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS: "5",
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
            kubernetesPort: "6443",
            serviceAccountDir: "/sa",
            holderIdentity: "pod-1",
            leaseDurationSeconds: 60,
            renewIntervalSeconds: 20,
            healthPort: 9000,
            logLevel: "debug",
        });
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
