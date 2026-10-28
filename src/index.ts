///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Wires the controller together. The process entry point is main.ts; everything here takes its environment and its
// I/O seams as arguments so tests can run it without a cluster.
import { ServerClient } from "./api/ServerClient.js";
import { loadConfig, type ControllerConfig } from "./config.js";
import { Controller } from "./Controller.js";
import { DesiredStateSync } from "./DesiredStateSync.js";
import { HealthServer } from "./HealthServer.js";
import { KubeClient, type KubeTransport } from "./kube/KubeClient.js";
import { LeaseElector } from "./kube/LeaseElector.js";
import { Logger, stdoutSink, type LogSink } from "./log.js";
import { Reconciler } from "./reconcile/Reconciler.js";
import { readControllerVersion } from "./version.js";

export interface Overrides {
    kubeTransport?: KubeTransport;
    fetch?: typeof fetch;
    sink?: LogSink;
    /** Listen for health checks here instead of the configured port (0: any free port). */
    healthPort?: number;
}

export interface Running {
    config: ControllerConfig;
    controller: Controller;
    elector: LeaseElector;
    sync: DesiredStateSync;
    reconciler: Reconciler;
    healthPort: number;
    log: Logger;
    stop(): Promise<void>;
}

/** Loads the configuration, starts the health endpoints and the controller. Throws when the configuration is invalid. */
export async function startController(env: NodeJS.ProcessEnv = process.env, overrides: Overrides = {}): Promise<Running> {
    const config: ControllerConfig = loadConfig(env);
    const version: string = readControllerVersion();
    const log: Logger = new Logger(config.logLevel, overrides.sink ?? stdoutSink).child({ component: "dns-controller" });

    const kube = new KubeClient({
        host: config.kubernetesHost,
        port: config.kubernetesPort,
        serviceAccountDir: config.serviceAccountDir,
        transport: overrides.kubeTransport,
    });
    const namespace: string = await kube.namespace();
    const elector = new LeaseElector({
        kube,
        namespace,
        name: config.leaseName,
        identity: config.holderIdentity,
        leaseDurationSeconds: config.leaseDurationSeconds,
        renewIntervalSeconds: config.renewIntervalSeconds,
        log,
        // Holding the Lease is what lets the reconciler write: reconcile at once rather than at its next retry.
        onAcquired: () => reconciler.wake(),
    });
    const server = new ServerClient({
        baseUrl: config.serverUrl,
        tokenFile: config.serverTokenFile,
        controllerVersion: version,
        timeoutMs: config.serverTimeoutMs,
        longPollTimeoutMs: config.longPollTimeoutSeconds * 1000,
        fetch: overrides.fetch,
    });
    const sync = new DesiredStateSync({
        server,
        lease: elector,
        log,
        controllerVersion: version,
        identity: config.holderIdentity,
        statusIntervalSeconds: config.statusIntervalSeconds,
        // The reconciler is created below, with the controller it asks before every write; nothing calls these before start().
        onDesiredState: (state) => reconciler.update(state),
    });
    const controller = new Controller({
        server,
        elector,
        sync,
        log,
        controllerVersion: version,
        handshakeRetrySeconds: config.handshakeRetrySeconds,
    });
    const reconciler = new Reconciler({
        kube,
        settings: {
            namespace,
            fullname: config.fullname,
            release: config.release,
            externalDnsImage: config.externalDnsImage,
            externalDnsServiceAccount: config.externalDnsServiceAccount,
            externalDnsResources: config.externalDnsResources,
            openbao: config.openbao,
        },
        // Writes only while compatible and holding the Lease, asked before every write.
        gate: controller,
        log,
        resyncMs: config.resyncMinutes * 60000,
    });
    const health = new HealthServer(() => controller.health());
    const healthPort: number = await health.listen(overrides.healthPort ?? config.healthPort);
    log.info("started", { version, namespace, healthPort, lease: config.leaseName, identity: config.holderIdentity });
    controller.start();

    return {
        config,
        controller,
        elector,
        sync,
        reconciler,
        healthPort,
        log,
        async stop(): Promise<void> {
            // The pass under way ends, its requests answered, before the Lease is released.
            await reconciler.stop();
            await controller.stop();
            await health.close();
            log.info("stopped");
        },
    };
}

/**
 * The process: start, then stop cleanly (releasing the Lease) on SIGTERM or SIGINT. Exits 1 when it cannot start, so
 * a bad configuration shows as a crash-looping pod with the reason as its last log line.
 */
export async function runMain(env: NodeJS.ProcessEnv = process.env, overrides: Overrides = {}): Promise<void> {
    let running: Running;
    try {
        running = await startController(env, overrides);
    } catch (err) {
        new Logger("info", overrides.sink ?? stdoutSink).error("start_failed", { component: "dns-controller", error: err });
        process.exit(1);
        return;
    }
    const shutdown = (signal: string): void => {
        running.log.info("shutting_down", { signal });
        void running.stop().then(() => process.exit(0));
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
}
