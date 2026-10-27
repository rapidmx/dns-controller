import { Logger, stdoutSink } from "../src/log.js";

const fixedNow = () => new Date("2026-10-27T10:00:00.000Z");

function capture(level: "debug" | "info" | "warn" | "error" = "info") {
    const lines: string[] = [];
    const log = new Logger(level, (line) => lines.push(line), {}, fixedNow);
    return { log, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("Logger", () => {
    it("writes one JSON object per line with time, level and message", () => {
        const { log, parsed } = capture();
        log.info("started", { port: 8081 });
        expect(parsed()).toEqual([{ time: "2026-10-27T10:00:00.000Z", level: "info", msg: "started", port: 8081 }]);
    });

    it("drops lines below the threshold", () => {
        const { log, parsed } = capture("warn");
        log.debug("a");
        log.info("b");
        log.warn("c");
        log.error("d");
        expect(parsed().map((e) => e.msg)).toEqual(["c", "d"]);
    });

    it("writes debug lines at the debug level", () => {
        const { log, parsed } = capture("debug");
        log.debug("a");
        expect(parsed()[0].level).toBe("debug");
    });

    it("serializes errors with name, message and a Kubernetes status", () => {
        const { log, parsed } = capture();
        const withStatus = Object.assign(new Error("conflict"), { status: 409 });
        log.error("failed", { error: withStatus, plain: new TypeError("bad") });
        expect(parsed()[0].error).toEqual({ name: "Error", message: "conflict", status: 409 });
        expect(parsed()[0].plain).toEqual({ name: "TypeError", message: "bad" });
    });

    it("never lets a field override time, level or msg", () => {
        const { log, parsed } = capture();
        log.info("real", { level: "error", msg: "fake", time: "never" });
        expect(parsed()[0]).toEqual({ time: "2026-10-27T10:00:00.000Z", level: "info", msg: "real" });
    });

    it("binds fields on a child, keeping the threshold, and lets call fields win", () => {
        const { log, parsed } = capture("warn");
        const child = log.child({ component: "dns-controller", lease: "a" });
        child.info("hidden");
        child.warn("shown", { lease: "b" });
        expect(parsed()).toEqual([
            { time: "2026-10-27T10:00:00.000Z", level: "warn", msg: "shown", component: "dns-controller", lease: "b" },
        ]);
    });

    it("defaults to info, stdout and the real clock", () => {
        const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        try {
            new Logger().debug("hidden");
            new Logger().info("shown");
            expect(write).toHaveBeenCalledTimes(1);
            const entry = JSON.parse(String(write.mock.calls[0][0]));
            expect(entry.msg).toBe("shown");
            expect(Date.parse(entry.time)).not.toBeNaN();
            stdoutSink("x");
            expect(write).toHaveBeenLastCalledWith("x\n");
        } finally {
            write.mockRestore();
        }
    });
});
