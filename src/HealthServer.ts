///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface HealthStatus {
    /** Whether `/readyz` answers 200. */
    ready: boolean;
    /** Shown in both answers' bodies, for `kubectl` and Diagnostics. Never secrets. */
    details: Record<string, unknown>;
}

/**
 * `/healthz` (liveness: the process and its event loop answer) and `/readyz` (readiness: the controller is not refusing
 * to act), on their own port so the probes never depend on the internal API's NetworkPolicy. GET and HEAD only.
 */
export class HealthServer {
    private readonly server: http.Server;

    constructor(private readonly status: () => HealthStatus) {
        this.server = http.createServer((req, res) => this.handle(req, res));
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const path: string = String(req.url).split("?")[0];
        if (req.method !== "GET" && req.method !== "HEAD") {
            this.send(res, 405, { error: "method not allowed" });
            return;
        }
        if (path === "/healthz") {
            this.send(res, 200, { status: "ok" });
        } else if (path === "/readyz") {
            const { ready, details } = this.status();
            this.send(res, ready ? 200 : 503, { status: ready ? "ready" : "not ready", ...details });
        } else {
            this.send(res, 404, { error: "not found" });
        }
    }

    private send(res: http.ServerResponse, status: number, body: unknown): void {
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
