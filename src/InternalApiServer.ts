///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { API_VERSION_V1, expectV1, SUPPORTED_API_VERSIONS, versionPath } from "./api/v1.js";
import type { ServiceAccountTokenVerifier } from "./auth/ServiceAccountTokenVerifier.js";
import type { Controller } from "./Controller.js";
import type { Logger } from "./log.js";

/** The most a request body may weigh by default. */
export const MAX_BODY_BYTES = 1024 * 1024;

export type InternalMethod = "GET" | "POST" | "PUT" | "DELETE";

/** One route of the internal API, under `/v1`. */
export interface InternalRoute {
    method: InternalMethod;
    /** Matched against the path after `/v1`; its groups are the route's parameters, as sent (still URL-encoded). */
    path: RegExp;
    /** The v1 `kind` the request body must be. A route without one takes no body. */
    kind?: string;
    handle(request: { params: string[]; body?: unknown }): Promise<{ status: number; body?: unknown }>;
}

export interface InternalApiServerOptions {
    verifier: Pick<ServiceAccountTokenVerifier, "verify">;
    /** The one subject whose token is accepted: the server's ServiceAccount, `system:serviceaccount:<namespace>:<name>`. */
    subject: string;
    /** Every route changes Kubernetes, so none is served unless the controller may write (compatible, holding the Lease). */
    gate: Pick<Controller, "mayWrite">;
    log: Logger;
    routes?: InternalRoute[];
    maxBodyBytes?: number;
}

/** A refusal: its status and the body the server reads it from. */
class Refusal {
    constructor(
        readonly status: number,
        readonly body: Record<string, unknown>
    ) {}
}

const UNSUPPORTED_VERSION = (): Refusal => new Refusal(400, { reason: "unsupported_api_version", supported: [...SUPPORTED_API_VERSIONS] });

/**
 * The controller's internal API (spec 7.3), on its own port behind the Service the server calls and a NetworkPolicy
 * admitting only the server pods. Its routes (the Kubernetes-Secret backend's secret writes) arrive with phase C3; this
 * is what every one of them goes through:
 *
 * 1. **Authentication first**, before the path is even looked at, so a caller without the server's token learns nothing:
 * a projected ServiceAccount token (`Authorization: Bearer`, audience `rapidmx-dns-controller`), verified against the
 * cluster's keys, whose subject must be exactly the server's. Every failure is the same `403 { reason: "forbidden" }`.
 * 2. **Versions:** routes live under `/v1`; another version, or a body of another `apiVersion` or `kind`, is
 * `400 { reason: "unsupported_api_version", supported }`, as the server answers the controller.
 * 3. **Single writer:** nothing is served while the controller may not write (`503 { reason: "not_ready" }`): an
 * incompatible controller serves no secret writes, and neither does a pod without the Lease.
 */
export class InternalApiServer {
    private readonly server: http.Server;
    private readonly maxBodyBytes: number;

    constructor(private readonly options: InternalApiServerOptions) {
        this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
        this.server = http.createServer((req, res) => void this.handle(req, res));
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            const { status, body } = await this.serve(req);
            this.send(res, status, body);
        } catch (err) {
            if (err instanceof Refusal) {
                this.send(res, err.status, err.body);
                return;
            }
            this.options.log.error("internal_api_failed", { method: req.method, path: this.pathOf(req), error: err });
            this.send(res, 500, { reason: "internal_error" });
        }
    }

    private pathOf(req: http.IncomingMessage): string {
        return String(req.url).split("?")[0];
    }

    private async serve(req: http.IncomingMessage): Promise<{ status: number; body?: unknown }> {
        await this.authenticate(req);
        const path: string = this.pathOf(req);
        const version: RegExpMatchArray | null = path.match(/^\/(v\d+)(\/.*)?$/);
        if (version && `/${version[1]}` !== versionPath(API_VERSION_V1)) {
            throw UNSUPPORTED_VERSION();
        }
        const rest: string = version?.[2] ?? "";
        const matching: InternalRoute[] = version ? (this.options.routes ?? []).filter((route) => route.path.test(rest)) : [];
        if (matching.length === 0) {
            throw new Refusal(404, { reason: "not_found" });
        }
        const route: InternalRoute | undefined = matching.find((r) => r.method === req.method);
        if (!route) {
            throw new Refusal(405, { reason: "method_not_allowed" });
        }
        if (!this.options.gate.mayWrite()) {
            throw new Refusal(503, { reason: "not_ready" });
        }
        const params: string[] = (rest.match(route.path) as RegExpMatchArray).slice(1);
        if (!route.kind) {
            return route.handle({ params });
        }
        const raw: string = await this.readBody(req);
        let body: unknown;
        try {
            body = JSON.parse(raw);
        } catch {
            throw new Refusal(400, { reason: "invalid_payload", message: "the body is not JSON" });
        }
        try {
            expectV1(body, route.kind);
        } catch {
            // Only an `ApiVersionError`: another apiVersion or kind.
            throw UNSUPPORTED_VERSION();
        }
        return route.handle({ params, body });
    }

    /** Refuses (403) any caller but the server's ServiceAccount, with the same answer whatever the reason. */
    private async authenticate(req: http.IncomingMessage): Promise<void> {
        const refuse = (reason: string): Refusal => {
            // The reason is the verifier's (or this method's) own text, never the token.
            this.options.log.warn("internal_api_refused", { method: req.method, path: this.pathOf(req), reason });
            return new Refusal(403, { reason: "forbidden" });
        };
        const match: RegExpMatchArray | null | undefined = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
        if (!match) {
            throw refuse("no bearer token");
        }
        let subject: string;
        try {
            subject = (await this.options.verifier.verify(match[1])).subject;
        } catch (err) {
            throw refuse((err as Error).message);
        }
        const presented: Buffer = Buffer.from(subject);
        const expected: Buffer = Buffer.from(this.options.subject);
        if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
            throw refuse("the token's subject is not the server's");
        }
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > this.maxBodyBytes) {
                    req.removeAllListeners("data");
                    req.resume();
                    reject(new Refusal(413, { reason: "too_large" }));
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
        });
    }

    private send(res: http.ServerResponse, status: number, body: unknown): void {
        if (body === undefined) {
            res.writeHead(status, { "Cache-Control": "no-store" });
            res.end();
            return;
        }
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
    }

    /**
     * Listens on `port` (0 picks a free one) and resolves with the port in use. Without a `host` it listens as Node does
     * by default: on `::`, which takes IPv4 too on a dual-stack pod and is the only address of a single-stack IPv6 one,
     * or on `0.0.0.0` where the pod has no IPv6.
     */
    listen(port: number, host?: string): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen({ port, host }, () => {
                this.server.off("error", reject);
                resolve((this.server.address() as AddressInfo).port);
            });
        });
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            this.server.closeAllConnections();
            this.server.close(() => resolve());
        });
    }
}
