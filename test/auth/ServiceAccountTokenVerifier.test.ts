import crypto, { type KeyObject } from "node:crypto";
import { ServiceAccountTokenVerifier, TokenError } from "../../src/auth/ServiceAccountTokenVerifier.js";
import { KubeError } from "../../src/kube/KubeClient.js";

const ISSUER = "https://kubernetes.default.svc.cluster.local";
const AUDIENCE = "rapidmx-dns-controller";
const SUBJECT = "system:serviceaccount:rapidmx:mail";
const NOW = Date.parse("2026-10-27T12:00:00Z");
const nowSeconds = Math.floor(NOW / 1000);

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

let rsa: { publicKey: KeyObject; privateKey: KeyObject };
let rsaOther: { publicKey: KeyObject; privateKey: KeyObject };
let ec: { publicKey: KeyObject; privateKey: KeyObject };

beforeAll(() => {
    rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    rsaOther = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
});

function jwk(key: KeyObject, kid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...key.export({ format: "jwk" }), kid, use: "sig", ...extra };
}

/** A signed JWT, the way the API server issues a projected ServiceAccount token. */
function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = rsa.privateKey): string {
    const head: Record<string, unknown> = { alg: "RS256", kid: "rsa-1", ...header };
    const body: Record<string, unknown> = {
        iss: ISSUER,
        aud: [AUDIENCE],
        sub: SUBJECT,
        iat: nowSeconds - 60,
        nbf: nowSeconds - 60,
        exp: nowSeconds + 3600,
        ...claims,
    };
    const data = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(body))}`;
    const signature: Buffer =
        head.alg === "ES256" ? crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }) : crypto.sign("sha256", Buffer.from(data), key);
    return `${data}.${b64url(signature)}`;
}

describe("ServiceAccountTokenVerifier", () => {
    let keys: unknown[];
    let discovery: unknown;
    let fail: Error | undefined;
    let now: number;
    let get: ReturnType<typeof vi.fn>;

    function verifier(extra: Partial<ConstructorParameters<typeof ServiceAccountTokenVerifier>[0]> = {}): ServiceAccountTokenVerifier {
        return new ServiceAccountTokenVerifier({ kube: { get } as any, audience: AUDIENCE, now: () => now, ...extra });
    }

    async function refusal(v: ServiceAccountTokenVerifier, t: string): Promise<TokenError> {
        let err: unknown;
        try {
            await v.verify(t);
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(TokenError);
        expect((err as Error).message).not.toContain(t);
        return err as TokenError;
    }

    beforeEach(() => {
        now = NOW;
        fail = undefined;
        keys = [jwk(rsa.publicKey, "rsa-1"), jwk(ec.publicKey, "ec-1")];
        discovery = { issuer: ISSUER, jwks_uri: "https://203.0.113.10:6443/openid/v1/jwks" };
        get = vi.fn(async (path: string) => {
            if (fail) {
                throw fail;
            }
            return path === "/.well-known/openid-configuration" ? discovery : { keys };
        });
    });

    it("verifies an RS256 token against the in-cluster keys and issuer, and caches them", async () => {
        const v = verifier();
        expect(await v.verify(token())).toEqual({ subject: SUBJECT });
        // In-cluster paths only, never the advertised jwks_uri (on k3s the node's public address).
        expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(["/.well-known/openid-configuration", "/openid/v1/jwks"]);
        expect(await v.verify(token({ sub: "system:serviceaccount:rapidmx:other" }))).toEqual({ subject: "system:serviceaccount:rapidmx:other" });
        expect(get).toHaveBeenCalledTimes(2);
    });

    it("verifies an ES256 token and a single-string audience", async () => {
        expect(await verifier().verify(token({ aud: AUDIENCE }, { alg: "ES256", kid: "ec-1" }, ec.privateKey))).toEqual({ subject: SUBJECT });
    });

    it("shares one key fetch between concurrent verifications", async () => {
        const v = verifier();
        await Promise.all([v.verify(token()), v.verify(token()), v.verify(token())]);
        expect(get).toHaveBeenCalledTimes(2);
    });

    it.each([
        ["another audience", { aud: ["rapidmx-internal-dns"] }, "the token is not for this audience"],
        ["no audience", { aud: undefined }, "the token is not for this audience"],
        ["another issuer", { iss: "https://evil.example" }, "the token's issuer is not the cluster's"],
        ["an expired token", { exp: nowSeconds - 61 }, "the token has expired"],
        ["no expiry", { exp: undefined }, "the token has expired"],
        ["a token not valid yet", { nbf: nowSeconds + 61 }, "the token is not valid yet"],
        ["no subject", { sub: "" }, "the token has no subject"],
    ])("refuses %s", async (_label, claims, message) => {
        expect((await refusal(verifier(), token(claims))).message).toBe(message);
    });

    it("allows a minute of clock skew either way", async () => {
        const v = verifier();
        expect(await v.verify(token({ exp: nowSeconds - 59, nbf: nowSeconds + 59 }))).toEqual({ subject: SUBJECT });
        expect(await verifier({ leewaySeconds: 0 }).verify(token({ exp: nowSeconds + 1, nbf: nowSeconds }))).toEqual({ subject: SUBJECT });
        expect((await refusal(verifier({ leewaySeconds: 0 }), token({ exp: nowSeconds }))).message).toBe("the token has expired");
    });

    it("refuses a token signed by another key under a known key id", async () => {
        expect((await refusal(verifier(), token({}, {}, rsaOther.privateKey))).message).toBe("the token's signature does not verify");
    });

    it("refuses a signature of the wrong length for ES256", async () => {
        const [head, body] = token({}, { alg: "ES256", kid: "ec-1" }, ec.privateKey).split(".");
        expect((await refusal(verifier(), `${head}.${body}.${b64url(Buffer.alloc(10))}`)).message).toBe("the token's signature does not verify");
    });

    it.each([
        ["none", { alg: "none" }],
        ["HS256", { alg: "HS256" }],
        ["RS512", { alg: "RS512" }],
    ])("refuses the algorithm %s", async (_label, header) => {
        const [head, body] = token().split(".");
        const forged = `${b64url(JSON.stringify({ kid: "rsa-1", ...header }))}.${body}.${head}`;
        expect((await refusal(verifier(), forged)).message).toBe("the token's algorithm is not RS256 or ES256");
    });

    it("refuses a key of another type than the token's algorithm says", async () => {
        expect((await refusal(verifier(), token({}, { alg: "ES256", kid: "rsa-1" }, ec.privateKey))).message).toBe("the token's key does not match its algorithm");
    });

    it.each([
        ["not three parts", "a.b"],
        ["characters outside base64url", "a.b+.c"],
        ["a header that is not JSON", `${b64url("{")}.${b64url("{}")}.c2ln`],
        ["a header that is not an object", `${b64url("1")}.${b64url("{}")}.c2ln`],
        ["claims that are not an object", `${b64url('{"alg":"RS256","kid":"rsa-1"}')}.${b64url("[1]")}.c2ln`],
        ["claims that are not JSON", `${b64url('{"alg":"RS256","kid":"rsa-1"}')}.${b64url("x")}.c2ln`],
        ["a token too long", `${"a".repeat(9000)}.${"b".repeat(9000)}.c`],
    ])("refuses a malformed token (%s)", async (_label, t) => {
        expect((await refusal(verifier(), t)).message).toBe("the token is malformed");
        expect(get).not.toHaveBeenCalled();
    });

    it("refuses a token without a key id", async () => {
        expect((await refusal(verifier(), token({}, { kid: undefined }))).message).toBe("the token names no key");
    });

    it("fetches the keys again for an unknown key id, at most once a minute", async () => {
        const v = verifier();
        await v.verify(token());
        expect(get).toHaveBeenCalledTimes(2);
        // The API server rotated its signing key: the new id is fetched.
        const rotated = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
        keys = [jwk(rotated.publicKey, "rsa-2")];
        now += 60000;
        expect(await v.verify(token({}, { kid: "rsa-2" }, rotated.privateKey))).toEqual({ subject: SUBJECT });
        expect(get).toHaveBeenCalledTimes(4);
        // Another unknown id within the minute is refused without asking again.
        now += 59999;
        expect((await refusal(v, token({}, { kid: "rsa-3" }))).message).toBe("the token's key is not one of the cluster's");
        expect(get).toHaveBeenCalledTimes(4);
        now += 1;
        expect((await refusal(v, token({}, { kid: "rsa-3" }))).message).toBe("the token's key is not one of the cluster's");
        expect(get).toHaveBeenCalledTimes(6);
        // The old key is gone with the refetch.
        expect((await refusal(v, token())).message).toBe("the token's key is not one of the cluster's");
    });

    it("refuses while the keys cannot be fetched, keeps the keys it has, and tries again after a minute", async () => {
        fail = new KubeError("GET /openid/v1/jwks: ECONNREFUSED");
        const v = verifier();
        expect((await refusal(v, token())).message).toBe("cannot fetch the cluster's service-account keys: GET /openid/v1/jwks: ECONNREFUSED");
        fail = undefined;
        expect((await refusal(v, token())).message).toBe("the token's key is not one of the cluster's");
        now += 60000;
        expect(await v.verify(token())).toEqual({ subject: SUBJECT });
        // A failed refetch for an unknown id leaves the known keys working.
        fail = new Error("down");
        now += 60000;
        expect((await refusal(v, token({}, { kid: "nope" }))).message).toBe("cannot fetch the cluster's service-account keys: down");
        expect(await v.verify(token())).toEqual({ subject: SUBJECT });
    });

    it("refuses when the discovery document names no issuer, or the key set is not one", async () => {
        discovery = { jwks_uri: "x" };
        expect((await refusal(verifier(), token())).message).toBe("cannot fetch the cluster's service-account keys: the discovery document names no issuer");
        discovery = { issuer: ISSUER };
        keys = undefined;
        get.mockImplementation(async (path: string) => (path === "/openid/v1/jwks" ? { keys: "x" } : discovery));
        expect((await refusal(verifier(), token())).message).toBe("cannot fetch the cluster's service-account keys: the key set has no keys");
        get.mockImplementation(async () => null);
        expect((await refusal(verifier(), token())).message).toBe("cannot fetch the cluster's service-account keys: the discovery document names no issuer");
    });

    it("skips keys it cannot use and uses the others", async () => {
        const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
        keys = [
            null,
            { ...jwk(rsa.publicKey, "x"), kid: undefined },
            { kty: "oct", k: "c2VjcmV0", kid: "hmac" },
            jwk(p384.publicKey, "ec-384"),
            jwk(rsa.publicKey, "enc", { use: "enc" }),
            jwk(rsa.publicKey, "rs512", { alg: "RS512" }),
            { kty: "RSA", kid: "empty-modulus", n: "!!", e: "AQAB" },
            jwk(crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey, "rsa-1024"),
            { kty: "RSA", kid: "no-modulus", e: "AQAB" },
            jwk(rsa.publicKey, "rsa-1", { alg: "RS256" }),
            jwk(rsaOther.publicKey, "rsa-1"),
        ];
        const v = verifier();
        expect(await v.verify(token())).toEqual({ subject: SUBJECT });
        for (const kid of ["hmac", "ec-384", "enc", "rs512", "empty-modulus", "rsa-1024", "no-modulus"]) {
            expect((await refusal(v, token({}, { kid }))).message).toBe("the token's key is not one of the cluster's");
        }
    });

    it("uses the system clock by default", async () => {
        const v = new ServiceAccountTokenVerifier({ kube: { get } as any, audience: AUDIENCE });
        const fresh = Math.floor(Date.now() / 1000);
        expect(await v.verify(token({ iat: fresh, nbf: fresh, exp: fresh + 600 }))).toEqual({ subject: SUBJECT });
    });
});
