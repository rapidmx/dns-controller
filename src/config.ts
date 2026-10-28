///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { LOG_LEVELS, type LogLevel } from "./log.js";

export const DEFAULT_SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
/** Where the server chart mounts the projected token with the audience `rapidmx-internal-dns`. */
export const DEFAULT_SERVER_TOKEN_FILE = "/var/run/secrets/rapidmx/internal-dns/token";

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
    /** The server release's full name, which names every object the controller writes (`<fullname>-external-dns-<uid>`, ...). */
    fullname: string;
    /** The Helm release: the `app.kubernetes.io/instance` label of those objects, which selects what this controller manages. */
    release: string;
    /** The one external-dns image the controller runs (`dns.externalDns.image`, by digest), whatever the desired state names. */
    externalDnsImage: string;
    /** The ServiceAccount every external-dns instance runs as (`<fullname>-external-dns`, created by the chart). */
    externalDnsServiceAccount: string;
    /** The external-dns container's `resources` (`dns.externalDns.resources`); none when unset. */
    externalDnsResources?: Record<string, unknown>;
    /** How often the whole desired state is reconciled again while nothing changes. */
    resyncMinutes: number;
}

/** The external-dns release the controller is built and tested against (spec 7.4). */
export const DEFAULT_EXTERNAL_DNS_IMAGE = "registry.k8s.io/external-dns/external-dns:v0.23.0";

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

/** A Kubernetes object name that is also a DNS label: what every name derived from it must stay. */
function kubernetesName(name: string, raw: string): string {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)) {
        throw new ConfigError(`${name} must be a Kubernetes name: lowercase letters, digits and '-', at most 63 (got '${raw}').`);
    }
    return raw;
}

function labelValue(name: string, raw: string): string {
    if (!/^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(raw)) {
        throw new ConfigError(`${name} must be a label value: letters, digits, '-', '_' and '.', at most 63 (got '${raw}').`);
    }
    return raw;
}

function jsonObject(env: NodeJS.ProcessEnv, name: string): Record<string, unknown> | undefined {
    const raw: string | undefined = env[name]?.trim();
    if (!raw) {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        value = undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`${name} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
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
    const fullname: string = kubernetesName("DNS_CONTROLLER_FULLNAME", required(env, "DNS_CONTROLLER_FULLNAME"));
    const externalDnsImage: string = optional(env, "DNS_CONTROLLER_EXTERNAL_DNS_IMAGE", DEFAULT_EXTERNAL_DNS_IMAGE);
    if (/\s/.test(externalDnsImage)) {
        throw new ConfigError(`DNS_CONTROLLER_EXTERNAL_DNS_IMAGE must be an image reference (got '${externalDnsImage}').`);
    }
    const externalDnsResources: Record<string, unknown> | undefined = jsonObject(env, "DNS_CONTROLLER_EXTERNAL_DNS_RESOURCES");
    return {
        serverUrl,
        serverTokenFile: optional(env, "DNS_CONTROLLER_SERVER_TOKEN_FILE", DEFAULT_SERVER_TOKEN_FILE),
        serverTimeoutMs: integer(env, "DNS_CONTROLLER_SERVER_TIMEOUT_MS", 10000, 100, 120000),
        handshakeRetrySeconds: integer(env, "DNS_CONTROLLER_HANDSHAKE_RETRY_SECONDS", 60, 1, 3600),
        longPollTimeoutSeconds: integer(env, "DNS_CONTROLLER_LONG_POLL_TIMEOUT_SECONDS", 75, 10, 900),
        statusIntervalSeconds: integer(env, "DNS_CONTROLLER_STATUS_INTERVAL_SECONDS", 60, 5, 3600),
        kubernetesHost: required(env, "KUBERNETES_SERVICE_HOST"),
        kubernetesPort: optional(env, "KUBERNETES_SERVICE_PORT", "443"),
        serviceAccountDir: optional(env, "DNS_CONTROLLER_SERVICE_ACCOUNT_DIR", DEFAULT_SERVICE_ACCOUNT_DIR),
        leaseName: required(env, "DNS_CONTROLLER_LEASE_NAME"),
        holderIdentity: env.POD_NAME?.trim() || required(env, "HOSTNAME"),
        leaseDurationSeconds,
        renewIntervalSeconds,
        healthPort: integer(env, "DNS_CONTROLLER_HEALTH_PORT", 8081, 1, 65535),
        logLevel: level as LogLevel,
        fullname,
        release: labelValue("DNS_CONTROLLER_RELEASE", required(env, "DNS_CONTROLLER_RELEASE")),
        externalDnsImage,
        externalDnsServiceAccount: kubernetesName(
            "DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT",
            optional(env, "DNS_CONTROLLER_EXTERNAL_DNS_SERVICE_ACCOUNT", `${fullname}-external-dns`)
        ),
        ...(externalDnsResources ? { externalDnsResources } : {}),
        resyncMinutes: integer(env, "DNS_CONTROLLER_RESYNC_MINUTES", 10, 1, 1440),
    };
}
