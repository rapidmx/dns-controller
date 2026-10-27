///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import { SUPPORTED_API_VERSIONS, type Handshake, type HandshakeResult } from "./v1.js";

export interface ServerClientOptions {
    /** The server's internal DNS API base, without a version (`.../internal/dns`). */
    baseUrl: string;
    /** The projected ServiceAccount token file (audience `rapidmx-internal-dns`). */
    tokenFile: string;
    controllerVersion: string;
    timeoutMs: number;
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
            response = await this.fetchFn(`${this.options.baseUrl}/handshake`, {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${await this.token()}`,
                },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(this.options.timeoutMs),
            });
        } catch (err) {
            return { state: "unavailable", error: (err as Error)?.message ?? String(err) };
        }
        if (response.status === 404) {
            // A server without the DNS API at all (older than DNS publishing, or publishing not enabled).
            return { state: "incompatible", reason: "the server has no internal DNS API (404)", serverApiVersions: [] };
        }
        if (!response.ok) {
            return { state: "unavailable", error: `HTTP ${response.status}` };
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
}
