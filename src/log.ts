///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

/** Where a finished log line goes. Replaceable so tests can capture lines. */
export type LogSink = (line: string) => void;

/** Writes one line to stdout: the container runtime and Kubernetes collect it from there. */
export function stdoutSink(line: string): void {
    process.stdout.write(`${line}\n`);
}

/** Turns an Error into something JSON.stringify keeps (an Error's own properties are not enumerable). */
function serializeValue(value: unknown): unknown {
    if (value instanceof Error) {
        const out: Record<string, unknown> = { name: value.name, message: value.message };
        const status: unknown = (value as { status?: unknown }).status;
        if (status !== undefined) {
            out.status = status;
        }
        return out;
    }
    return value;
}

/**
 * A structured logger: one JSON object per line with `time`, `level`, `msg` and the given fields. No dependency (the
 * controller ships with none at run time). Never pass a secret or a token in a field: lines are not filtered.
 */
export class Logger {
    private readonly threshold: number;

    constructor(
        level: LogLevel = "info",
        private readonly sink: LogSink = stdoutSink,
        private readonly bound: LogFields = {},
        private readonly now: () => Date = () => new Date()
    ) {
        this.threshold = LOG_LEVELS.indexOf(level);
    }

    /** A logger that adds `fields` to every line it writes. */
    child(fields: LogFields): Logger {
        return new Logger(LOG_LEVELS[this.threshold], this.sink, { ...this.bound, ...fields }, this.now);
    }

    debug(msg: string, fields?: LogFields): void {
        this.write("debug", msg, fields);
    }

    info(msg: string, fields?: LogFields): void {
        this.write("info", msg, fields);
    }

    warn(msg: string, fields?: LogFields): void {
        this.write("warn", msg, fields);
    }

    error(msg: string, fields?: LogFields): void {
        this.write("error", msg, fields);
    }

    private write(level: LogLevel, msg: string, fields: LogFields = {}): void {
        if (LOG_LEVELS.indexOf(level) < this.threshold) {
            return;
        }
        const entry: Record<string, unknown> = { time: this.now().toISOString(), level, msg };
        for (const [key, value] of Object.entries({ ...this.bound, ...fields })) {
            // The fixed keys win, so a field can never disguise a line's level or time.
            if (!(key in entry)) {
                entry[key] = serializeValue(value);
            }
        }
        this.sink(JSON.stringify(entry));
    }
}
