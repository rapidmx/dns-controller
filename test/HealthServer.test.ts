import { HealthServer, type HealthStatus } from "../src/HealthServer.js";
import { hasIpv6Loopback } from "./helpers/ipv6.js";

const ipv6: boolean = await hasIpv6Loopback();

describe("HealthServer", () => {
    let status: HealthStatus;
    let server: HealthServer;
    let base: string;

    beforeEach(async () => {
        status = { ready: true, details: { state: "compatible" } };
        server = new HealthServer(() => status);
        base = `http://127.0.0.1:${await server.listen(0, "127.0.0.1")}`;
    });

    afterEach(async () => {
        await server.close();
    });

    it("answers /healthz while the process runs", async () => {
        const res = await fetch(`${base}/healthz`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ status: "ok" });
    });

    it("answers /readyz from the status, with its details, ignoring a query", async () => {
        let res = await fetch(`${base}/readyz?verbose`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ready", state: "compatible" });
        status = { ready: false, details: { state: "incompatible", reason: "no API version in common" } };
        res = await fetch(`${base}/readyz`);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ status: "not ready", state: "incompatible", reason: "no API version in common" });
    });

    it("answers HEAD, refuses other methods and unknown paths", async () => {
        expect((await fetch(`${base}/healthz`, { method: "HEAD" })).status).toBe(200);
        expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(405);
        expect((await fetch(`${base}/metrics`)).status).toBe(404);
    });

    it("rejects listening on a port in use", async () => {
        const port = Number(new URL(base).port);
        const other = new HealthServer(() => status);
        await expect(other.listen(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
        await other.close();
    });

    it("listens on every address by default", async () => {
        const other = new HealthServer(() => status);
        const port = await other.listen(0);
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        await other.close();
    });

    // A single-stack IPv6 cluster reaches the pod only over IPv6: a server bound to 0.0.0.0 would refuse the probes.
    it.skipIf(!ipv6)("takes IPv6 as well as IPv4 by default", async () => {
        const other = new HealthServer(() => status);
        const port = await other.listen(0);
        expect((await fetch(`http://[::1]:${port}/healthz`)).status).toBe(200);
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
        await other.close();
    });
});
