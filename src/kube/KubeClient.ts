///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFile } from "node:fs/promises";
import https from "node:https";

/** The most a Kubernetes API answer may weigh. The controller only reads its own, small objects. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type KubeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface KubeRequest {
    method: KubeMethod;
    url: URL;
    headers: Record<string, string>;
    body?: string;
    /** PEM CA certificate(s) the API server's certificate must chain to: the cluster's, from the ServiceAccount mount. */
    ca?: string;
    timeoutMs: number;
}

export interface KubeResponse {
    status: number;
    body: string;
}

/** Performs one request. Replaceable so tests need no cluster. */
export type KubeTransport = (request: KubeRequest) => Promise<KubeResponse>;

/** An error answer, or no answer, from the API server. */
export class KubeError extends Error {
    constructor(
        message: string,
        /** The HTTP status, when the API server answered. */
        readonly status?: number,
        /** The `reason` of a Kubernetes `Status` answer (`NotFound`, `Conflict`, `AlreadyExists`, ...). */
        readonly reason?: string
    ) {
        super(message);
        this.name = "KubeError";
    }
}

/**
 * The default transport: `node:https` with the cluster CA given per request, so the cluster CA is trusted for calls to
 * the API server only (the global `fetch` cannot take a per-request CA without the `undici` package, and
 * `NODE_EXTRA_CA_CERTS` would trust it for every call the process makes). Certificate verification is never off.
 */
export function httpsTransport(request: KubeRequest): Promise<KubeResponse> {
    return new Promise((resolve, reject) => {
        const req = https.request(
            request.url,
            {
                method: request.method,
                headers: request.headers,
                ca: request.ca,
                rejectUnauthorized: true,
                timeout: request.timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) {
                        req.destroy(new Error("the response was too large"));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => resolve({ status: Number(res.statusCode), body: Buffer.concat(chunks).toString("utf8") }));
            }
        );
        req.on("timeout", () => req.destroy(new Error(`no answer within ${request.timeoutMs} ms`)));
        req.on("error", reject);
        req.end(request.body);
    });
}

export interface KubeClientOptions {
    /** The API server host and port, from the pod's `KUBERNETES_SERVICE_HOST`/`_PORT`. */
    host: string;
    port: string;
    serviceAccountDir: string;
    timeoutMs?: number;
    transport?: KubeTransport;
}

export interface ApplyOptions {
    /** The server-side apply field manager; the controller always uses its own. */
    fieldManager: string;
    /** Take over fields another manager set. */
    force?: boolean;
}

/**
 * A minimal Kubernetes REST client for the pod's own ServiceAccount: JSON requests against the API server, nothing
 * more. Deliberately not `@kubernetes/client-node`: the controller touches a handful of resource types in its own
 * namespace, and it is the most privileged RapidMX pod, so it carries no dependency it does not need.
 */
export class KubeClient {
    private readonly timeoutMs: number;
    private readonly transport: KubeTransport;
    private ca?: string;

    constructor(private readonly options: KubeClientOptions) {
        this.timeoutMs = options.timeoutMs ?? 10000;
        this.transport = options.transport ?? httpsTransport;
    }

    /** The namespace this pod runs in, from its ServiceAccount mount. */
    async namespace(): Promise<string> {
        return (await readFile(`${this.options.serviceAccountDir}/namespace`, "utf8")).trim();
    }

    /** Read on every request: a bound ServiceAccount token is rotated by the kubelet. */
    async token(): Promise<string> {
        return (await readFile(`${this.options.serviceAccountDir}/token`, "utf8")).trim();
    }

    /** The cluster CA. Required: the controller never talks to an API server it cannot verify. */
    private async clusterCa(): Promise<string> {
        if (this.ca === undefined) {
            const path = `${this.options.serviceAccountDir}/ca.crt`;
            try {
                this.ca = await readFile(path, "utf8");
            } catch (err) {
                throw new KubeError(`cannot read the cluster CA ${path}: ${(err as NodeJS.ErrnoException).code}`);
            }
        }
        return this.ca;
    }

    get<T>(path: string): Promise<T> {
        return this.request<T>("GET", path);
    }

    create<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("POST", path, JSON.stringify(body), "application/json");
    }

    replace<T>(path: string, body: unknown): Promise<T> {
        return this.request<T>("PUT", path, JSON.stringify(body), "application/json");
    }

    /** Server-side apply: idempotent, and only the fields this manager sets are its own. */
    apply<T>(path: string, body: unknown, options: ApplyOptions): Promise<T> {
        const query = new URLSearchParams({ fieldManager: options.fieldManager });
        if (options.force) {
            query.set("force", "true");
        }
        // JSON is YAML, which is what the apply content type takes.
        return this.request<T>("PATCH", `${path}?${query}`, JSON.stringify(body), "application/apply-patch+yaml");
    }

    delete<T>(path: string): Promise<T> {
        return this.request<T>("DELETE", path);
    }

    /**
     * An object's metadata alone (`PartialObjectMetadata`): its labels and annotations without its contents, so reading a
     * Secret's labels never brings its values into this process.
     */
    getMetadata<T>(path: string): Promise<T> {
        return this.request<T>("GET", path, undefined, undefined, "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1");
    }

    private async request<T>(method: KubeMethod, path: string, body?: string, contentType?: string, accept = "application/json"): Promise<T> {
        const host: string = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
        const url = new URL(`https://${host}:${this.options.port}${path}`);
        const headers: Record<string, string> = {
            Accept: accept,
            Authorization: `Bearer ${await this.token()}`,
        };
        if (contentType) {
            headers["Content-Type"] = contentType;
        }
        const where = `${method} ${url.pathname}`;
        const ca: string = await this.clusterCa();
        let response: KubeResponse;
        try {
            response = await this.transport({ method, url, headers, body, ca, timeoutMs: this.timeoutMs });
        } catch (err) {
            const code: unknown = (err as { code?: unknown })?.code;
            throw new KubeError(`${where}: ${typeof code === "string" ? code : (err as Error)?.message ?? String(err)}`);
        }
        let parsed: unknown;
        try {
            parsed = response.body ? JSON.parse(response.body) : undefined;
        } catch {
            throw new KubeError(`${where}: HTTP ${response.status}, the answer was not JSON`, response.status);
        }
        if (response.status < 200 || response.status >= 300) {
            const status = parsed as { reason?: unknown; message?: unknown } | undefined;
            const reason: string | undefined = typeof status?.reason === "string" ? status.reason : undefined;
            const detail: string = typeof status?.message === "string" ? `: ${status.message}` : "";
            throw new KubeError(`${where}: HTTP ${response.status}${detail}`, response.status, reason);
        }
        return parsed as T;
    }
}

/** Whether `err` is the API server's answer with `status` (e.g. 404 Not Found, 409 Conflict). */
export function isKubeStatus(err: unknown, status: number): boolean {
    return err instanceof KubeError && err.status === status;
}
