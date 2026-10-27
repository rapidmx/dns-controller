///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto, { type KeyObject } from "node:crypto";
import type { KubeClient } from "../kube/KubeClient.js";

/** The most a token may weigh: a projected ServiceAccount token is about 1 KiB. */
const MAX_TOKEN_LENGTH = 16 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
/** The smallest RSA key accepted. */
const MIN_RSA_BITS = 2048;

type Algorithm = "RS256" | "ES256";

/** A token that does not verify. The message says why and never repeats the token. */
export class TokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TokenError";
    }
}

export interface ServiceAccountTokenVerifierOptions {
    /** The pod's own Kubernetes client: the keys and issuer are read from the API server it trusts. */
    kube: Pick<KubeClient, "get">;
    /** The audience a token must carry (`rapidmx-dns-controller` for the server's calls to the controller). */
    audience: string;
    /** The least time between two fetches of the keys (default a minute). */
    refetchIntervalMs?: number;
    /** Clock skew allowed between the API server that issued a token and this pod (default a minute). */
    leewaySeconds?: number;
    /** Milliseconds since the epoch. Replaceable for tests. */
    now?: () => number;
}

interface VerificationKey {
    alg: Algorithm;
    key: KeyObject;
}

/** `segment` base64url-decoded and parsed as a JSON object, or undefined. */
function jsonSegment(segment: string): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
        return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

/** The algorithm a JWK is for, or undefined for a key that can't sign tokens the API server issues (RS256 or ES256). */
function keyAlgorithm(jwk: Record<string, unknown>): Algorithm | undefined {
    if (jwk.use !== undefined && jwk.use !== "sig") {
        return undefined;
    }
    const alg: Algorithm | undefined = jwk.kty === "RSA" ? "RS256" : jwk.kty === "EC" && jwk.crv === "P-256" ? "ES256" : undefined;
    return alg !== undefined && (jwk.alg === undefined || jwk.alg === alg) ? alg : undefined;
}

/**
 * Verifies a projected ServiceAccount token (a JWT the API server signed) against the cluster's service-account issuer
 * keys, the way the API server's own authenticator does, without a TokenReview (which would need a ClusterRole):
 *
 * - The keys and the issuer come **in-cluster**, from `/openid/v1/jwks` and `/.well-known/openid-configuration` on the
 * API server, through the pod's own Kubernetes client (its token, the cluster CA). The `jwks_uri` the discovery
 * document advertises is not used: on k3s it is the node's public address on port 6443, which a pod may not reach and
 * which the in-cluster certificate does not name. The default `system:service-account-issuer-discovery` binding lets
 * every ServiceAccount read both.
 * - Signature (RS256 or ES256, with the key the token's `kid` names), issuer, audience, expiry and not-before, with
 * `leewaySeconds` of clock skew. The caller compares the subject.
 * - Keys are cached, and fetched again for an unknown `kid` (the API server rotated its key) at most once per
 * `refetchIntervalMs`, so forged ids cannot make the controller hammer the API server. While they cannot be fetched,
 * the call is refused and the keys already known stay in use.
 */
export class ServiceAccountTokenVerifier {
    private readonly now: () => number;
    private readonly refetchIntervalMs: number;
    private readonly leewaySeconds: number;
    private keys: Map<string, VerificationKey> = new Map();
    private issuer?: string;
    private lastFetchAt?: number;
    private fetching?: Promise<void>;

    constructor(private readonly options: ServiceAccountTokenVerifierOptions) {
        this.now = options.now ?? Date.now;
        this.refetchIntervalMs = options.refetchIntervalMs ?? 60000;
        this.leewaySeconds = options.leewaySeconds ?? 60;
    }

    /** Resolves to the verified token's subject (`system:serviceaccount:<namespace>:<name>`); rejects with `TokenError`. */
    async verify(token: string): Promise<{ subject: string }> {
        if (token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
            throw new TokenError("the token is malformed");
        }
        const [headerPart, claimsPart, signaturePart] = token.split(".");
        const header = jsonSegment(headerPart);
        const claims = jsonSegment(claimsPart);
        if (!header || !claims) {
            throw new TokenError("the token is malformed");
        }
        if (header.alg !== "RS256" && header.alg !== "ES256") {
            throw new TokenError("the token's algorithm is not RS256 or ES256");
        }
        if (typeof header.kid !== "string" || header.kid === "") {
            throw new TokenError("the token names no key");
        }
        const key: VerificationKey = await this.keyFor(header.kid);
        if (key.alg !== header.alg) {
            throw new TokenError("the token's key does not match its algorithm");
        }
        const data: Buffer = Buffer.from(`${headerPart}.${claimsPart}`);
        const signature: Buffer = Buffer.from(signaturePart, "base64url");
        const valid: boolean =
            key.alg === "RS256"
                ? crypto.verify("sha256", data, key.key, signature)
                : signature.length === 64 && crypto.verify("sha256", data, { key: key.key, dsaEncoding: "ieee-p1363" }, signature);
        if (!valid) {
            throw new TokenError("the token's signature does not verify");
        }
        this.checkClaims(claims);
        return { subject: claims.sub as string };
    }

    private checkClaims(claims: Record<string, unknown>): void {
        const now: number = Math.floor(this.now() / 1000);
        if (claims.iss !== this.issuer) {
            throw new TokenError("the token's issuer is not the cluster's");
        }
        const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!audiences.includes(this.options.audience)) {
            throw new TokenError("the token is not for this audience");
        }
        if (typeof claims.exp !== "number" || claims.exp + this.leewaySeconds <= now) {
            throw new TokenError("the token has expired");
        }
        if (typeof claims.nbf === "number" && claims.nbf - this.leewaySeconds > now) {
            throw new TokenError("the token is not valid yet");
        }
        if (typeof claims.sub !== "string" || claims.sub === "") {
            throw new TokenError("the token has no subject");
        }
    }

    /** The key `kid` names, fetching the keys when it is unknown and the last fetch is old enough. */
    private async keyFor(kid: string): Promise<VerificationKey> {
        let key: VerificationKey | undefined = this.keys.get(kid);
        if (!key && (this.fetching || this.lastFetchAt === undefined || this.now() - this.lastFetchAt >= this.refetchIntervalMs)) {
            this.fetching ??= this.fetchKeys().finally(() => (this.fetching = undefined));
            await this.fetching;
            key = this.keys.get(kid);
        }
        if (!key) {
            throw new TokenError("the token's key is not one of the cluster's");
        }
        return key;
    }

    /** The issuer and the raw key set, from the API server. */
    private async fetchDocuments(): Promise<{ issuer: string; jwks: unknown[] }> {
        const [discovery, set] = await Promise.all([
            this.options.kube.get<{ issuer?: unknown } | null>("/.well-known/openid-configuration"),
            this.options.kube.get<{ keys?: unknown } | null>("/openid/v1/jwks"),
        ]);
        if (typeof discovery?.issuer !== "string" || discovery.issuer === "") {
            throw new Error("the discovery document names no issuer");
        }
        if (!Array.isArray(set?.keys)) {
            throw new Error("the key set has no keys");
        }
        return { issuer: discovery.issuer, jwks: set.keys };
    }

    private async fetchKeys(): Promise<void> {
        this.lastFetchAt = this.now();
        let documents: { issuer: string; jwks: unknown[] };
        try {
            documents = await this.fetchDocuments();
        } catch (err) {
            throw new TokenError(`cannot fetch the cluster's service-account keys: ${(err as Error).message}`);
        }
        const keys: Map<string, VerificationKey> = new Map();
        for (const entry of documents.jwks) {
            const jwk = entry as Record<string, unknown> | null;
            const alg: Algorithm | undefined = jwk ? keyAlgorithm(jwk) : undefined;
            if (!jwk || !alg || typeof jwk.kid !== "string" || keys.has(jwk.kid)) {
                continue;
            }
            let key: KeyObject;
            try {
                key = crypto.createPublicKey({ key: jwk, format: "jwk" });
            } catch {
                // A key node:crypto can't import is one no token can be verified with.
                continue;
            }
            // node:crypto imports an RSA key of any size, an empty modulus included; the API server's are 2048 bits or more.
            if (alg === "RS256" && key.asymmetricKeyDetails!.modulusLength! < MIN_RSA_BITS) {
                continue;
            }
            keys.set(jwk.kid, { alg, key });
        }
        this.issuer = documents.issuer;
        this.keys = keys;
    }
}
