///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { LOG_LEVELS, type LogLevel } from "./log.js";

export const DEFAULT_SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
/** Where the server chart mounts the projected token with the audience `rapidmx-internal-dns`. */
export const DEFAULT_SERVER_TOKEN_FILE = "/var/run/secrets/rapidmx/internal-dns/token";
/** The audience of the server's projected token on its calls to the controller. */
export const DEFAULT_API_AUDIENCE = "rapidmx-dns-controller";

/** Everything the controller is configured with, read once at start-up from the environment the server chart renders. */
export interface ControllerConfig {
    /** The server's internal DNS API base, e.g. `http://<fullname>.<namespace>.svc:3000/internal/dns`. */
    serverUrl: string;
    /** The projected ServiceAccount token presented to the server (re-read on every call; the kubelet rotates it). */
    serverTokenFile: string;
    /** Timeout of one call to the server, in milliseconds. */
    serverTimeoutMs: number;
    /** How long to wait before asking again after the server said the API versions are incompatible. */
    handshakeRetrySeconds: number;
    /** How long one desired-state long poll may take: longer than the server holds one (55 s by default). */
    longPollTimeoutSeconds: number;
    /** How often the controller reports its status while nothing changes. */
    statusIntervalSeconds: number;
    /** The one ServiceAccount whose token the internal API accepts: the server's, `system:serviceaccount:<namespace>:<name>`. */
    serverSubject: string;
    /** The audience the server's token must carry. */
    apiAudience: string;
    /** Port of the internal API the server calls. */
    apiPort: number;
    /** The Kubernetes API server, from the pod's `KUBERNETES_SERVICE_HOST`/`_PORT`. */
    kubernetesHost: string;
    kubernetesPort: string;
    serviceAccountDir: string;
    /** The Lease the controller must hold before writing (`<fullname>-dns-controller`). */
    leaseName: string;
    /** This process's identity in the Lease: the pod name. */
    holderIdentity: string;
    leaseDurationSeconds: number;
    renewIntervalSeconds: number;
    /** Port of `/healthz` and `/readyz`. */
    healthPort: number;
    logLevel: LogLevel;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value: string | undefined = env[name]?.trim();
    if (!value) {
        throw new ConfigError(`${name} must be set.`);
    }
    return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
    const value: string | undefined = env[name]?.trim();
    return value ? value : fallback;
}

/** A whole number in [min, max]; unset means `fallback`, anything else invalid fails start-up instead of being guessed. */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw: string | undefined = env[name]?.trim();
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value: number = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ConfigError(`${name} must be a whole number from ${min} to ${max} (got '${raw}').`);
    }
    return value;
}

function httpUrl(name: string, raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`${name} must be an absolute URL (got '${raw}').`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ConfigError(`${name} must be an http or https URL (got '${raw}').`);
    }
    return raw.replace(/\/+$/, "");
}

/** A ServiceAccount's token subject: both parts are Kubernetes names (lowercase letters, digits, `-` and `.`). */
function serviceAccountSubject(name: string, raw: string): string {
    if (!/^system:serviceaccount:[a-z0-9]([a-z0-9.-]*[a-z0-9])?:[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(raw)) {
        throw new ConfigError(`${name} must be system:serviceaccount:<namespace>:<name> (got '${raw}').`);
    }
    return raw;
}

/** Reads and validates the configuration. Throws `ConfigError` naming the first bad variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
    const serverUrl: string = httpUrl("DNS_CONTROLLER_SERVER_URL", required(env, "DNS_CONTROLLER_SERVER_URL"));
    const leaseDurationSeconds: number = integer(env, "DNS_CONTROLLER_LEASE_DURATION_SECONDS", 30, 5, 300);
    const renewIntervalSeconds: number = integer(env, "DNS_CONTROLLER_LEASE_RENEW_SECONDS", 10, 1, 300);
    // Renewing at most every third of the duration leaves two attempts before the Lease could pass to someone else.
    if (renewIntervalSeconds * 3 > leaseDurationSeconds) {
        throw new ConfigError(
            `DNS_CONTROLLER_LEASE_RENEW_SECONDS (${renewIntervalSeconds}) must be at most a third of ` +
                `DNS_CONTROLLER_LEASE_DURATION_SECONDS (${leaseDurationSeconds}).`
        );
    }
    const level: string = optional(env, "DNS_CONTROLLER_LOG_LEVEL", "info").toLowerCase();
    if (!(LOG_LEVELS as readonly string[]).includes(level)) {
        throw new ConfigError(`DNS_CONTROLLER_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got '${level}').`);
    }
    return {
        serverUrl,
        serverTokenFile: optional(env, "DNS_CONTROLLER_SERVER_TOKEN_FILE", DEFAULT_SERVER_TOKEN_FILE),
        serverTimeoutMs: integer(env, "DNS_CONTROLLER_SERVER_TIMEOUT_MS", 10000, 100, 120000),
        handshakeRetrySeconds: integer(env, "DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS", 60, 1, 3600),
        longPollTimeoutSeconds: integer(env, "DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS", 75, 10, 900),
        statusIntervalSeconds: integer(env, "DNS_CONTROLLER_STATUS_INTERVAL_SECONDS", 60, 5, 3600),
        serverSubject: serviceAccountSubject("DNS_CONTROLLER_SERVER_SUBJECT", required(env, "DNS_CONTROLLER_SERVER_SUBJECT")),
        apiAudience: optional(env, "DNS_CONTROLLER_API_AUDIENCE", DEFAULT_API_AUDIENCE),
        apiPort: integer(env, "DNS_CONTROLLER_API_PORT", 8080, 1, 65535),
        kubernetesHost: required(env, "KUBERNETES_SERVICE_HOST"),
        kubernetesPort: optional(env, "KUBERNETES_SERVICE_PORT", "443"),
        serviceAccountDir: optional(env, "DNS_CONTROLLER_SERVICE_ACCOUNT_DIR", DEFAULT_SERVICE_ACCOUNT_DIR),
        leaseName: required(env, "DNS_CONTROLLER_LEASE_NAME"),
        holderIdentity: env.POD_NAME?.trim() || required(env, "HOSTNAME"),
        leaseDurationSeconds,
        renewIntervalSeconds,
        healthPort: integer(env, "DNS_CONTROLLER_HEALTH_PORT", 8081, 1, 65535),
        logLevel: level as LogLevel,
    };
}
