///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import {
    API_VERSION_V1,
    ApiVersionError,
    expectV1,
    parseDesiredState,
    parseProviderCredentials,
    SUPPORTED_API_VERSIONS,
    versionPath,
    type DesiredStateV1,
    type DnsProviderCredentialsV1,
    type Handshake,
    type HandshakeResult,
    type StatusReportResultV1,
    type StatusReportV1,
} from "./v1.js";

export interface ServerClientOptions {
    /** The server's internal DNS API base, without a version (`.../internal/dns`). */
    baseUrl: string;
    /** The projected ServiceAccount token file (audience `rapidmx-internal-dns`). */
    tokenFile: string;
    controllerVersion: string;
    timeoutMs: number;
    /** How long a desired-state long poll may take: longer than the server holds one (55 s by default). */
    longPollTimeoutMs: number;
    /** Replaceable for tests. */
    fetch?: typeof fetch;
}

/** What the handshake established. */
export type HandshakeOutcome =
    | { state: "compatible"; apiVersion: string; serverVersion: string }
    /** The two sides share no API version: the controller must not act. */
    | { state: "incompatible"; reason: string; serverVersion?: string; serverApiVersions: string[] }
    /** No usable answer (network, timeout, 5xx, auth): not a mismatch, so retried with backoff. */
    | { state: "unavailable"; error: string };

/** What a v1 call came to. */
export type CallOutcome<T> =
    | { state: "ok"; value: T }
    /** The server no longer speaks v1 (rolled back underneath the controller): back to the handshake. */
    | { state: "incompatible"; reason: string }
    /** No usable answer (network, timeout, 5xx, a refused token or request): retried with backoff. */
    | { state: "unavailable"; error: string }
    /** An answer of the right version that is not what v1 says: retried with backoff, never acted on. */
    | { state: "invalid"; error: string };

/** The most of a refusal's message the controller keeps (it is logged). */
const MAX_REFUSAL_MESSAGE_LENGTH = 200;

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Parses the frozen `HandshakeResult` shape; anything else is undefined. */
function parseHandshakeResult(body: unknown): HandshakeResult | undefined {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const r = body as Partial<Record<keyof HandshakeResult, unknown>>;
    if (r.kind !== "HandshakeResult" || typeof r.compatible !== "boolean" || !isStringArray(r.apiVersions)) {
        return undefined;
    }
    return {
        kind: "HandshakeResult",
        serverVersion: typeof r.serverVersion === "string" ? r.serverVersion : "unknown",
        apiVersions: r.apiVersions,
        compatible: r.compatible,
        selected: typeof r.selected === "string" ? r.selected : undefined,
        reason: typeof r.reason === "string" ? r.reason : undefined,
    };
}

/** The error of a call that got no usable answer: a refused token says so, since that is a deployment problem. */
function unavailable(status: number): { state: "unavailable"; error: string } {
    return {
        state: "unavailable",
        error: status === 401 || status === 403 ? `the server refused the controller's token (HTTP ${status})` : `HTTP ${status}`,
    };
}

/** Calls the RapidMX server's internal DNS API. */
export class ServerClient {
    private readonly fetchFn: typeof fetch;

    constructor(private readonly options: ServerClientOptions) {
        this.fetchFn = options.fetch ?? fetch;
    }

    /** The projected token, read on every call: the kubelet rotates it. */
    private async token(): Promise<string> {
        return (await readFile(this.options.tokenFile, "utf8")).trim();
    }

    /** One request with the controller's token. Throws on no answer (network, timeout, abort, unreadable token). */
    private async send(method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
        const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${await this.token()}` };
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
        return this.fetchFn(`${this.options.baseUrl}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
    }

    /**
     * The start-up compatibility check (`POST <base>/handshake`). The server picks the best version both sides speak;
     * the controller accepts its choice only if it is one it speaks too. Never throws.
     */
    async handshake(): Promise<HandshakeOutcome> {
        const request: Handshake = {
            kind: "Handshake",
            controllerVersion: this.options.controllerVersion,
            apiVersions: [...SUPPORTED_API_VERSIONS],
        };
        let response: Response;
        try {
            response = await this.send("POST", "/handshake", request, this.options.timeoutMs);
        } catch (err) {
            return { state: "unavailable", error: (err as Error)?.message ?? String(err) };
        }
        if (response.status === 404) {
            // A server without the DNS API at all (older than DNS publishing, or publishing not enabled).
            return { state: "incompatible", reason: "the server has no internal DNS API (404)", serverApiVersions: [] };
        }
        if (!response.ok) {
            return unavailable(response.status);
        }
        let result: HandshakeResult | undefined;
        try {
            result = parseHandshakeResult(await response.json());
        } catch {
            result = undefined;
        }
        if (!result) {
            return { state: "incompatible", reason: "the server's handshake answer was not a HandshakeResult", serverApiVersions: [] };
        }
        const common: string | undefined = SUPPORTED_API_VERSIONS.find((v) => result.apiVersions.includes(v));
        if (!result.compatible) {
            return {
                state: "incompatible",
                reason: result.reason ?? `no API version in common (server: ${result.apiVersions.join(", ") || "none"})`,
                serverVersion: result.serverVersion,
                serverApiVersions: result.apiVersions,
            };
        }
        if (result.selected === undefined || !SUPPORTED_API_VERSIONS.includes(result.selected)) {
            return {
                state: "incompatible",
                reason: `the server selected ${result.selected ?? "no version"}, which this controller does not speak` +
                    (common ? ` (both speak ${common})` : ""),
                serverVersion: result.serverVersion,
                serverApiVersions: result.apiVersions,
            };
        }
        return { state: "compatible", apiVersion: result.selected, serverVersion: result.serverVersion };
    }

    /**
     * One v1 call: the request, then the answer read by `read`. The server signals that it no longer speaks v1 by
     * answering 404 (no `/v1` routes: a server rolled back to one without them) or `400 unsupported_api_version`; both
     * send the controller back to the handshake. Never throws.
     */
    private async callV1<T>(
        method: string,
        path: string,
        body: unknown,
        timeoutMs: number,
        read: (payload: unknown) => T,
        signal?: AbortSignal
    ): Promise<CallOutcome<T>> {
        let response: Response;
        try {
            response = await this.send(method, `${versionPath(API_VERSION_V1)}${path}`, body, timeoutMs, signal);
        } catch (err) {
            return { state: "unavailable", error: (err as Error)?.message ?? String(err) };
        }
        let payload: unknown;
        let json = true;
        try {
            payload = await response.json();
        } catch {
            json = false;
        }
        if (response.status === 404) {
            return { state: "incompatible", reason: `the server has no ${API_VERSION_V1} DNS API (404)` };
        }
        if (!response.ok) {
            const refusal = (json ? payload : undefined) as { reason?: unknown; supported?: unknown; message?: unknown } | null | undefined;
            if (response.status === 400 && refusal?.reason === "unsupported_api_version") {
                const supported: string = isStringArray(refusal.supported) && refusal.supported.length > 0 ? refusal.supported.join(", ") : "none";
                return { state: "incompatible", reason: `the server does not speak ${API_VERSION_V1} (it speaks ${supported})` };
            }
            if (response.status === 400 && typeof refusal?.reason === "string") {
                // The server's refusal names the field it found wrong, never a value: what makes it safe to log.
                const message: string = typeof refusal.message === "string" ? `: ${refusal.message.slice(0, MAX_REFUSAL_MESSAGE_LENGTH)}` : "";
                return { state: "unavailable", error: `HTTP 400: ${refusal.reason}${message}` };
            }
            return unavailable(response.status);
        }
        if (!json) {
            return { state: "invalid", error: "the answer was not JSON" };
        }
        try {
            return { state: "ok", value: read(payload) };
        } catch (err) {
            if (err instanceof ApiVersionError) {
                return { state: "incompatible", reason: err.message };
            }
            return { state: "invalid", error: (err as Error).message };
        }
    }

    /**
     * `GET <base>/v1/desired-state`. Without `since` the server answers at once; with it, it holds the request until the
     * version moves away from `since` or its long poll ends, so the request gets the long timeout. `signal` ends it
     * early (the controller stopping).
     */
    desiredState(since?: number, signal?: AbortSignal): Promise<CallOutcome<DesiredStateV1>> {
        const query: string = since !== undefined ? `?since=${since}` : "";
        const timeoutMs: number = since !== undefined ? this.options.longPollTimeoutMs : this.options.timeoutMs;
        return this.callV1("GET", `/desired-state${query}`, undefined, timeoutMs, parseDesiredState, signal);
    }

    /**
     * `GET <base>/v1/providers/:uid/credentials`: the provider's credentials, decrypted by the server. A 404 is also a
     * config that is gone, so the caller treats any outcome but `ok` as "keep what you have and try again".
     */
    providerCredentials(uid: string, signal?: AbortSignal): Promise<CallOutcome<DnsProviderCredentialsV1>> {
        return this.callV1("GET", `/providers/${encodeURIComponent(uid)}/credentials`, undefined, this.options.timeoutMs, parseProviderCredentials, signal);
    }

    /** `PUT <base>/v1/status`, answered with a `StatusReportResult`. */
    reportStatus(report: StatusReportV1): Promise<CallOutcome<StatusReportResultV1>> {
        return this.callV1("PUT", "/status", report, this.options.timeoutMs, (payload) =>
            expectV1<StatusReportResultV1>(payload, "StatusReportResult")
        );
    }
}
