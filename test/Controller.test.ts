import type { HandshakeOutcome } from "../src/api/ServerClient.js";
import { Controller } from "../src/Controller.js";
import { Logger } from "../src/log.js";

const compatible: HandshakeOutcome = { state: "compatible", apiVersion: "dns.rapidmx.io/v1", serverVersion: "1.0.0-beta.47" };
const incompatible: HandshakeOutcome = {
    state: "incompatible",
    reason: "no API version in common",
    serverVersion: "2.0.0",
    serverApiVersions: ["dns.rapidmx.io/v2"],
};
const unavailable: HandshakeOutcome = { state: "unavailable", error: "fetch failed" };

describe("Controller", () => {
    let answers: HandshakeOutcome[];
    let handshakes: number;
    let holds: boolean;
    let elector: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; holds: () => boolean };
    let lines: string[];

    function controller(extra: Partial<ConstructorParameters<typeof Controller>[0]> = {}): Controller {
        return new Controller({
            server: {
                handshake: async () => {
                    handshakes++;
                    return answers.length > 1 ? answers.shift() : answers[0];
                },
            },
            elector,
            log: new Logger("debug", (l) => lines.push(l)),
            controllerVersion: "0.1.0",
            handshakeRetrySeconds: 60,
            ...extra,
        });
    }

    const logged = () => lines.map((l) => JSON.parse(l));

    beforeEach(() => {
        vi.useFakeTimers();
        handshakes = 0;
        holds = false;
        lines = [];
        elector = { start: vi.fn(), stop: vi.fn(async () => undefined), holds: () => holds };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts the Lease after a compatible handshake and handshakes no more", async () => {
        answers = [compatible];
        const c = controller();
        expect(c.currentState).toBe("starting");
        expect(c.health()).toEqual({ ready: true, details: { state: "starting", controllerVersion: "0.1.0", leaseHolder: false } });
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.currentState).toBe("compatible");
        expect(elector.start).toHaveBeenCalledTimes(1);
        expect(c.mayWrite()).toBe(false);
        holds = true;
        expect(c.mayWrite()).toBe(true);
        expect(c.health()).toEqual({
            ready: true,
            details: { state: "compatible", controllerVersion: "0.1.0", leaseHolder: true, apiVersion: "dns.rapidmx.io/v1", serverVersion: "1.0.0-beta.47" },
        });
        await vi.advanceTimersByTimeAsync(600000);
        expect(handshakes).toBe(1);
        // A later compatible answer (C3 re-checks on every call) changes nothing.
        await c.attempt();
        expect(elector.start).toHaveBeenCalledTimes(1);
        expect(logged()[0]).toMatchObject({ level: "info", msg: "dns_api_compatible" });
    });

    it("refuses to act on a mismatch: no Lease, not ready, logged, and retried every interval", async () => {
        answers = [incompatible];
        const c = controller();
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.currentState).toBe("incompatible");
        expect(elector.start).not.toHaveBeenCalled();
        expect(elector.stop).toHaveBeenCalledTimes(1);
        holds = true;
        expect(c.mayWrite()).toBe(false);
        expect(c.health()).toEqual({
            ready: false,
            details: { state: "incompatible", controllerVersion: "0.1.0", leaseHolder: true, reason: "no API version in common", serverVersion: "2.0.0" },
        });
        expect(logged()[0]).toMatchObject({
            level: "error",
            msg: "dns_api_incompatible",
            controllerVersion: "0.1.0",
            serverVersion: "2.0.0",
            serverApiVersions: ["dns.rapidmx.io/v2"],
        });
        await vi.advanceTimersByTimeAsync(59999);
        expect(handshakes).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(handshakes).toBe(2);
    });

    it("recovers when the other side is upgraded", async () => {
        answers = [incompatible, compatible];
        const c = controller();
        c.start();
        await vi.advanceTimersByTimeAsync(60000);
        expect(c.currentState).toBe("compatible");
        expect(elector.start).toHaveBeenCalledTimes(1);
        expect(c.health().ready).toBe(true);
    });

    it("stays ready and backs off while the server is unavailable, then proceeds", async () => {
        answers = [unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, unavailable, compatible];
        const c = controller({ backoffInitialMs: 1000, backoffMaxMs: 8000 });
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.currentState).toBe("unavailable");
        expect(c.health()).toEqual({
            ready: true,
            details: { state: "unavailable", controllerVersion: "0.1.0", leaseHolder: false, lastError: "fetch failed" },
        });
        const delays = logged().map((e) => e.retryInMs);
        expect(delays).toEqual([1000]);
        await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 8000 + 8000 + 8000);
        expect(logged().filter((e) => e.msg === "dns_api_unavailable").map((e) => e.retryInMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
        expect(c.currentState).toBe("compatible");
    });

    it("keeps reporting a known mismatch while the server is briefly unavailable", async () => {
        answers = [incompatible, unavailable, compatible];
        const c = controller({ handshakeRetrySeconds: 1 });
        c.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(c.currentState).toBe("incompatible");
        expect(c.health().ready).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(c.currentState).toBe("compatible");
    });

    it("resets the backoff after an answer", async () => {
        answers = [unavailable, unavailable, incompatible, unavailable];
        const c = controller({ handshakeRetrySeconds: 1 });
        c.start();
        await vi.advanceTimersByTimeAsync(1000 + 2000 + 1000);
        expect(logged().filter((e) => e.msg === "dns_api_unavailable").map((e) => e.retryInMs)).toEqual([1000, 2000, 1000]);
        await c.stop();
    });

    it("uses default backoff bounds", async () => {
        answers = [unavailable];
        const c = controller();
        c.start();
        await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 30000);
        expect(logged().map((e) => e.retryInMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        await c.stop();
    });

    it("stops: no more handshakes, Lease released, not ready", async () => {
        answers = [unavailable];
        const c = controller();
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        await c.stop();
        expect(elector.stop).toHaveBeenCalledTimes(1);
        expect(c.health().ready).toBe(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(handshakes).toBe(1);
        await c.attempt();
        expect(handshakes).toBe(1);
    });

    it("ignores a handshake answer that arrives after stop", async () => {
        let release: (o: HandshakeOutcome) => void = () => undefined;
        const c = controller({ server: { handshake: () => new Promise((resolve) => (release = resolve)) } });
        c.start();
        await c.stop();
        release(compatible);
        await vi.advanceTimersByTimeAsync(0);
        expect(c.currentState).toBe("stopped");
        expect(elector.start).not.toHaveBeenCalled();
    });

    describe("with the desired-state sync", () => {
        let sync: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; health: () => Record<string, unknown> };
        let recheck: (reason: string) => void;

        beforeEach(() => {
            sync = {
                start: vi.fn((onIncompatible: (reason: string) => void) => (recheck = onIncompatible)),
                stop: vi.fn(),
                health: () => ({ desiredStateVersion: 42 }),
            };
        });

        it("syncs while compatible, and shows the desired-state version", async () => {
            answers = [compatible];
            const c = controller({ sync });
            c.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(sync.start).toHaveBeenCalledTimes(1);
            expect(c.health().details).toMatchObject({ state: "compatible", desiredStateVersion: 42 });
            await c.stop();
            expect(sync.stop).toHaveBeenCalled();
        });

        it("does not sync while incompatible", async () => {
            answers = [incompatible];
            const c = controller({ sync });
            c.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(sync.start).not.toHaveBeenCalled();
            expect(sync.stop).toHaveBeenCalled();
            expect(c.health().details).not.toHaveProperty("desiredStateVersion");
        });

        it("goes back to the handshake when a later call finds the versions no longer match, and stops writing meanwhile", async () => {
            let release: (o: HandshakeOutcome) => void = () => undefined;
            const handshake = vi.fn(async () => compatible);
            const c = controller({ sync, server: { handshake } });
            c.start();
            await vi.advanceTimersByTimeAsync(0);
            holds = true;
            expect(c.mayWrite()).toBe(true);
            handshake.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
            recheck("the server has no dns.rapidmx.io/v1 DNS API (404)");
            expect(c.currentState).toBe("starting");
            expect(c.mayWrite()).toBe(false);
            expect(sync.stop).toHaveBeenCalledTimes(1);
            expect(logged().find((e) => e.msg === "dns_api_recheck")).toMatchObject({
                level: "warn",
                reason: "the server has no dns.rapidmx.io/v1 DNS API (404)",
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(handshake).toHaveBeenCalledTimes(2);
            // The server was rolled back: the handshake now says so, and the controller refuses to act.
            release(incompatible);
            await vi.advanceTimersByTimeAsync(0);
            expect(c.currentState).toBe("incompatible");
            expect(elector.stop).toHaveBeenCalled();
            await c.stop();
        });

        it("resumes syncing when the handshake still matches, without asking again more than once an interval", async () => {
            const handshake = vi.fn(async () => compatible);
            const c = controller({ sync, server: { handshake } });
            c.start();
            await vi.advanceTimersByTimeAsync(0);
            recheck("first");
            await vi.advanceTimersByTimeAsync(0);
            expect(handshake).toHaveBeenCalledTimes(2);
            expect(c.currentState).toBe("compatible");
            expect(sync.start).toHaveBeenCalledTimes(2);
            expect(elector.start).toHaveBeenCalledTimes(2);
            // A server that says "compatible" but has no /v1 must not make the controller spin.
            await vi.advanceTimersByTimeAsync(10000);
            recheck("second");
            await vi.advanceTimersByTimeAsync(49999);
            expect(handshake).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(handshake).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(60000);
            recheck("third");
            await vi.advanceTimersByTimeAsync(0);
            expect(handshake).toHaveBeenCalledTimes(4);
            await c.stop();
        });

        it("ignores a recheck once it is no longer compatible", async () => {
            answers = [compatible];
            const c = controller({ sync });
            c.start();
            await vi.advanceTimersByTimeAsync(0);
            await c.stop();
            recheck("late");
            await vi.advanceTimersByTimeAsync(60000);
            expect(c.currentState).toBe("stopped");
            expect(handshakes).toBe(1);
        });
    });
});
