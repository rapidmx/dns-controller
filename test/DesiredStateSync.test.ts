import { readFileSync } from "node:fs";
import type { CallOutcome } from "../src/api/ServerClient.js";
import { parseDesiredState, type DesiredStateV1, type StatusReportResultV1, type StatusReportV1 } from "../src/api/v1.js";
import { DesiredStateSync } from "../src/DesiredStateSync.js";
import { Logger } from "../src/log.js";

function desired(version: number): DesiredStateV1 {
    const state = parseDesiredState(JSON.parse(readFileSync(new URL("./fixtures/api/v1/desired-state.json", import.meta.url), "utf8")));
    return { ...state, version };
}

const ok = (version: number): CallOutcome<DesiredStateV1> => ({ state: "ok", value: desired(version) });
const reported: CallOutcome<StatusReportResultV1> = { state: "ok", value: { apiVersion: "dns.rapidmx.io/v1", kind: "StatusReportResult" } };

interface Poll {
    since?: number;
    signal?: AbortSignal;
    answer: (outcome: CallOutcome<DesiredStateV1>) => void;
}

describe("DesiredStateSync", () => {
    let polls: Poll[];
    let reports: StatusReportV1[];
    let reportAnswer: () => Promise<CallOutcome<StatusReportResultV1>>;
    let holds: boolean;
    let lines: string[];
    let received: DesiredStateV1[];
    let incompatible: ReturnType<typeof vi.fn>;
    let honourAbort: boolean;

    function sync(extra: Partial<ConstructorParameters<typeof DesiredStateSync>[0]> = {}): DesiredStateSync {
        return new DesiredStateSync({
            server: {
                desiredState: (since?: number, signal?: AbortSignal) =>
                    new Promise((resolve) => {
                        polls.push({ since, signal, answer: resolve });
                        if (honourAbort) {
                            signal?.addEventListener("abort", () => resolve({ state: "unavailable", error: "aborted" }));
                        }
                    }),
                reportStatus: async (report: StatusReportV1) => {
                    reports.push(report);
                    return reportAnswer();
                },
            },
            lease: { holds: () => holds },
            log: new Logger("debug", (l) => lines.push(l)),
            controllerVersion: "0.1.0",
            identity: "mail-dns-controller-abc",
            statusIntervalSeconds: 60,
            onDesiredState: (state) => received.push(state),
            ...extra,
        });
    }

    const logged = () => lines.map((l) => JSON.parse(l));
    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

    beforeEach(() => {
        vi.useFakeTimers();
        polls = [];
        reports = [];
        reportAnswer = async () => reported;
        holds = false;
        lines = [];
        received = [];
        incompatible = vi.fn();
        honourAbort = true;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads the whole state first, then long-polls since its version, reporting each new version", async () => {
        const s = sync();
        expect(s.health()).toEqual({});
        s.start(incompatible);
        await tick();
        expect(polls.length).toBe(1);
        expect(polls[0].since).toBeUndefined();
        expect(polls[0].signal).toBeInstanceOf(AbortSignal);
        polls[0].answer(ok(42));
        await tick();
        expect(received.map((r) => r.version)).toEqual([42]);
        expect(s.desiredState?.version).toBe(42);
        expect(reports).toEqual([
            {
                apiVersion: "dns.rapidmx.io/v1",
                kind: "StatusReport",
                controllerVersion: "0.1.0",
                desiredStateVersion: 42,
                lease: { holder: false, identity: "mail-dns-controller-abc" },
                providers: [],
                endpoints: [],
                operations: [],
            },
        ]);
        expect(logged().find((e) => e.msg === "desired_state_received")).toMatchObject({
            level: "info",
            version: 42,
            providers: 1,
            endpointSets: 1,
            operations: 0,
        });
        expect(s.health()).toEqual({ desiredStateVersion: 42 });
        // At most one request a second, even when the server answers at once.
        expect(polls.length).toBe(1);
        await tick(1000);
        expect(polls.length).toBe(2);
        expect(polls[1].since).toBe(42);
        s.stop();
    });

    it("treats an answer with its own version as no change", async () => {
        const s = sync();
        s.start(incompatible);
        await tick();
        polls[0].answer(ok(42));
        await tick(1000);
        await tick(5000);
        polls[1].answer(ok(42));
        await tick();
        expect(received.length).toBe(1);
        expect(reports.length).toBe(1);
        // The long poll took longer than the minimum interval, so the next one starts at once.
        await tick();
        expect(polls[2].since).toBe(42);
        s.stop();
    });

    it("treats any other version as a change, a lower one too (the server's counter was reset)", async () => {
        const s = sync();
        s.start(incompatible);
        await tick();
        polls[0].answer(ok(42));
        await tick(1000);
        polls[1].answer(ok(3));
        await tick(1000);
        expect(received.map((r) => r.version)).toEqual([42, 3]);
        expect(reports.map((r) => r.desiredStateVersion)).toEqual([42, 3]);
        expect(polls[2].since).toBe(3);
        s.stop();
    });

    it("asks for the whole state again after a restart, whatever its version", async () => {
        const s = sync();
        s.start(incompatible);
        s.start(incompatible);
        await tick();
        expect(polls.length).toBe(1);
        polls[0].answer(ok(42));
        await tick(1000);
        s.stop();
        expect(polls[1].signal.aborted).toBe(true);
        s.start(incompatible);
        await tick();
        expect(polls[2].since).toBeUndefined();
        polls[2].answer(ok(42));
        await tick();
        expect(received.map((r) => r.version)).toEqual([42, 42]);
        s.stop();
    });

    it("goes back to the handshake when the server no longer speaks v1, and stops", async () => {
        const s = sync();
        s.start(incompatible);
        await tick();
        polls[0].answer({ state: "incompatible", reason: "the server has no dns.rapidmx.io/v1 DNS API (404)" });
        await tick();
        expect(incompatible).toHaveBeenCalledTimes(1);
        expect(incompatible).toHaveBeenCalledWith("the server has no dns.rapidmx.io/v1 DNS API (404)");
        await tick(120000);
        expect(polls.length).toBe(1);
        expect(reports).toEqual([]);
    });

    it("backs off while the server is unavailable or its answer is malformed, keeping the state it has", async () => {
        const s = sync({ backoffInitialMs: 1000, backoffMaxMs: 3000 });
        s.start(incompatible);
        await tick();
        polls[0].answer(ok(42));
        await tick(1000);
        polls[1].answer({ state: "unavailable", error: "HTTP 503" });
        await tick();
        expect(s.health()).toEqual({ desiredStateVersion: 42, syncError: "HTTP 503" });
        expect(polls.length).toBe(2);
        await tick(1000);
        polls[2].answer({ state: "invalid", error: "'version' must be a whole number" });
        await tick(2000);
        polls[3].answer({ state: "unavailable", error: "HTTP 503" });
        await tick(3000);
        polls[4].answer({ state: "unavailable", error: "HTTP 503" });
        await tick(3000);
        expect(polls[5].since).toBe(42);
        polls[5].answer(ok(42));
        await tick(1000);
        expect(s.health()).toEqual({ desiredStateVersion: 42 });
        polls[6].answer({ state: "unavailable", error: "fetch failed" });
        await tick();
        const failures = logged().filter((e) => e.msg === "desired_state_unavailable" || e.msg === "desired_state_invalid");
        expect(failures.map((e) => [e.level, e.msg, e.retryInMs])).toEqual([
            ["warn", "desired_state_unavailable", 1000],
            ["error", "desired_state_invalid", 2000],
            ["warn", "desired_state_unavailable", 3000],
            ["warn", "desired_state_unavailable", 3000],
            ["warn", "desired_state_unavailable", 1000],
        ]);
        expect(s.desiredState?.version).toBe(42);
        s.stop();
    });

    it("uses default backoff bounds", async () => {
        const s = sync();
        s.start(incompatible);
        for (let i = 0; i < 7; i++) {
            await tick(30000);
            polls[i].answer({ state: "unavailable", error: "down" });
        }
        await tick();
        expect(logged().filter((e) => e.msg === "desired_state_unavailable").map((e) => e.retryInMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        s.stop();
    });

    it("reports every interval, saying whether it holds the Lease", async () => {
        const s = sync({ statusIntervalSeconds: 10 });
        s.start(incompatible);
        await tick(10000);
        expect(reports).toEqual([
            {
                apiVersion: "dns.rapidmx.io/v1",
                kind: "StatusReport",
                controllerVersion: "0.1.0",
                lease: { holder: false, identity: "mail-dns-controller-abc" },
                providers: [],
                endpoints: [],
                operations: [],
            },
        ]);
        holds = true;
        polls[0].answer(ok(7));
        await tick();
        await tick(10000);
        expect(reports.map((r) => [r.lease.holder, r.desiredStateVersion])).toEqual([
            [false, undefined],
            [true, 7],
            [true, 7],
        ]);
        expect(s.health()).toMatchObject({ desiredStateVersion: 7 });
        s.stop();
        await tick(60000);
        expect(reports.length).toBe(3);
    });

    it("logs a report the server refused or could not take, and goes on", async () => {
        reportAnswer = async () => ({ state: "unavailable", error: "HTTP 400: invalid_payload: 'lease' ..." });
        const s = sync({ statusIntervalSeconds: 10 });
        s.start(incompatible);
        await tick(10000);
        reportAnswer = async () => ({ state: "invalid", error: "the answer was not JSON" });
        await tick(10000);
        expect(logged().filter((e) => e.msg === "status_report_failed").map((e) => [e.level, e.error])).toEqual([
            ["warn", "HTTP 400: invalid_payload: 'lease' ..."],
            ["warn", "the answer was not JSON"],
        ]);
        expect(incompatible).not.toHaveBeenCalled();
        s.stop();
    });

    it("goes back to the handshake when the server refuses the report's version, once", async () => {
        reportAnswer = async () => ({ state: "incompatible", reason: "the server does not speak dns.rapidmx.io/v1 (it speaks none)" });
        const s = sync({ statusIntervalSeconds: 10 });
        s.start(incompatible);
        await tick(10000);
        expect(incompatible).toHaveBeenCalledWith("the server does not speak dns.rapidmx.io/v1 (it speaks none)");
        expect(polls[0].signal.aborted).toBe(true);
        await tick(60000);
        expect(incompatible).toHaveBeenCalledTimes(1);
        expect(reports.length).toBe(1);
    });

    it("never sends two reports at once, but sends the one asked for meanwhile afterwards", async () => {
        let release: () => void = () => undefined;
        reportAnswer = () =>
            new Promise((resolve) => {
                release = () => resolve(reported);
            });
        const s = sync({ statusIntervalSeconds: 10 });
        s.start(incompatible);
        await tick(10000);
        expect(reports.length).toBe(1);
        polls[0].answer(ok(42));
        await tick(1000);
        polls[1].answer(ok(43));
        await tick(1000);
        expect(reports.length).toBe(1);
        release();
        await tick();
        expect(reports.map((r) => r.desiredStateVersion)).toEqual([undefined, 43]);
        release();
        await tick();
        expect(reports.length).toBe(2);
        s.stop();
    });

    it("ignores what arrives after it stopped", async () => {
        let release: () => void = () => undefined;
        reportAnswer = () =>
            new Promise((resolve) => {
                release = () => resolve({ state: "incompatible", reason: "late" });
            });
        // A server whose answer was already on its way when the controller stopped.
        honourAbort = false;
        const s = sync({ statusIntervalSeconds: 10 });
        s.start(incompatible);
        await tick(10000);
        s.stop();
        polls[0].answer(ok(42));
        release();
        await tick();
        expect(received).toEqual([]);
        expect(incompatible).not.toHaveBeenCalled();
        expect(polls.length).toBe(1);
        // A stopped sync sends nothing.
        await s.report();
        expect(reports.length).toBe(1);
    });

    it("logs a desired-state callback that throws and goes on polling and reporting", async () => {
        const s = sync({
            onDesiredState: (state) => {
                received.push(state);
                throw new Error("reconcile failed");
            },
        });
        s.start(incompatible);
        await tick();
        polls[0].answer(ok(1));
        await tick();
        expect(logged().find((e) => e.msg === "desired_state_apply_failed")).toMatchObject({ level: "error", version: 1, error: { message: "reconcile failed" } });
        expect(reports.map((r) => r.desiredStateVersion)).toEqual([1]);
        await tick(1000);
        expect(polls[1].since).toBe(1);
        polls[1].answer(ok(2));
        await tick();
        expect(received.map((r) => r.version)).toEqual([1, 2]);
        expect(s.desiredState?.version).toBe(2);
        s.stop();
    });

    it("works without a desired-state callback", async () => {
        const s = sync({ onDesiredState: undefined });
        s.start(incompatible);
        await tick();
        polls[0].answer(ok(1));
        await tick();
        expect(s.desiredState?.version).toBe(1);
        s.stop();
    });

    describe("status entries", () => {
        const entries = {
            providers: [{ providerUid: "cloudflare-main", readyReplicas: 1, image: "registry.k8s.io/external-dns/external-dns:v0.23.0", lastRolloutAt: "2026-10-28T08:00:00.000Z" }],
            endpoints: [{ endpointSetId: "domain-example-com", generation: 3, observedGeneration: 3 }],
            operations: [{ id: "op-1", state: "running" as const }],
        };

        it("puts the providers', endpoints' and operations' entries in the report of a pod that holds the Lease, read for the state it has", async () => {
            const read = vi.fn(async (_state: DesiredStateV1) => entries);
            holds = true;
            const s = sync({ entries: read });
            s.start(incompatible);
            await tick();
            polls[0].answer(ok(42));
            await tick();
            expect(read).toHaveBeenCalledTimes(1);
            expect(read.mock.calls[0][0].version).toBe(42);
            expect(reports).toHaveLength(1);
            expect(reports[0]).toMatchObject({ desiredStateVersion: 42, lease: { holder: true }, ...entries });
            s.stop();
        });

        it("reads them again for every report, so the next one carries what changed", async () => {
            let ready = 0;
            holds = true;
            const s = sync({
                statusIntervalSeconds: 10,
                entries: async () => ({ ...entries, providers: [{ ...entries.providers[0], readyReplicas: ready++ }] }),
            });
            s.start(incompatible);
            await tick();
            polls[0].answer(ok(42));
            await tick();
            await tick(10000);
            expect(reports.map((r) => r.providers[0].readyReplicas)).toEqual([0, 1]);
            s.stop();
        });

        it("reads nothing and reports none when the pod does not hold the Lease: the server acts only on the holder's report", async () => {
            const read = vi.fn(async () => entries);
            const s = sync({ entries: read });
            s.start(incompatible);
            await tick();
            polls[0].answer(ok(42));
            await tick();
            expect(read).not.toHaveBeenCalled();
            expect(reports[0]).toMatchObject({ lease: { holder: false }, providers: [], endpoints: [], operations: [] });
            s.stop();
        });

        it("names in a report the version its entries were read for, even when a newer state arrives while they are being read", async () => {
            const reads: { version: number; done: (e: typeof entries) => void }[] = [];
            holds = true;
            const s = sync({
                entries: (state) => new Promise((resolve) => reads.push({ version: state.version, done: resolve })),
            });
            s.start(incompatible);
            await tick();
            polls[0].answer(ok(42));
            await tick();
            expect(reads.map((r) => r.version)).toEqual([42]);
            // The next state arrives while the entries of 42 are still being read.
            await tick(1000);
            polls[1].answer(ok(43));
            await tick();
            expect(s.desiredState?.version).toBe(43);
            reads[0].done(entries);
            await tick();
            expect(reports.map((r) => r.desiredStateVersion)).toEqual([42]);
            expect(reports[0]).toMatchObject(entries);
            // The report asked for meanwhile follows, read for 43.
            expect(reads.map((r) => r.version)).toEqual([42, 43]);
            reads[1].done({ providers: [], endpoints: [], operations: [] });
            await tick();
            expect(reports.map((r) => r.desiredStateVersion)).toEqual([42, 43]);
            s.stop();
        });

        it("sends the report without entries, and goes on reporting, when reading them throws", async () => {
            let fail = true;
            holds = true;
            const s = sync({
                statusIntervalSeconds: 10,
                entries: async () => {
                    if (fail) {
                        throw new Error("a TypeError reading something");
                    }
                    return entries;
                },
            });
            s.start(incompatible);
            await tick();
            polls[0].answer(ok(42));
            await tick();
            expect(reports).toHaveLength(1);
            expect(reports[0]).toMatchObject({ desiredStateVersion: 42, lease: { holder: true }, providers: [], endpoints: [], operations: [] });
            expect(logged().filter((l) => l.msg === "status_entries_failed")).toMatchObject([
                { level: "warn", error: { name: "Error", message: "a TypeError reading something" } },
            ]);
            // The periodic chain was not broken by it.
            fail = false;
            await tick(10000);
            expect(reports).toHaveLength(2);
            expect(reports[1]).toMatchObject(entries);
            s.stop();
        });

        it("reads nothing before it has a desired state to read them for", async () => {
            const read = vi.fn(async () => entries);
            holds = true;
            const s = sync({ statusIntervalSeconds: 10, entries: read });
            s.start(incompatible);
            await tick(10000);
            expect(read).not.toHaveBeenCalled();
            expect(reports[0]).toMatchObject({ lease: { holder: true }, providers: [], endpoints: [], operations: [] });
            s.stop();
        });
    });
});
