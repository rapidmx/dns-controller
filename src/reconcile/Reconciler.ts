///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ServerClient } from "../api/ServerClient.js";
import { CREDENTIAL_FIELD, type DesiredStateV1, type DnsProviderV1, type EndpointSetV1 } from "../api/v1.js";
import { isKubeStatus, type KubeClient } from "../kube/KubeClient.js";
import type { Logger } from "../log.js";
import { listManaged } from "./listManaged.js";
import {
    acceptsExternalDnsImage,
    ANNOTATION_CREDENTIALS_GENERATION,
    credentialsSecret,
    credentialsSecretName,
    deploymentName,
    dnsEndpoint,
    dnsEndpointName,
    ENDPOINT_SET_ID,
    externalDnsDeployment,
    FIELD_MANAGER,
    isOurSecret,
    LABEL_OPERATION,
    LABEL_PROVIDER,
    nestedZones,
    type Manifest,
    type ManifestSettings,
    type SecretManifest,
} from "./manifests.js";
import { NotWriterError } from "./NotWriterError.js";
import type { OperationRunner } from "./OperationRunner.js";

export interface ReconcilerOptions {
    kube: Pick<KubeClient, "apply" | "get" | "getMetadata" | "delete">;
    /** Where a provider's credentials come from when its Secret has to be written (7.3). */
    server: Pick<ServerClient, "providerCredentials">;
    settings: ManifestSettings;
    /** Asked immediately before every write: the controller writes only while compatible and holding the Lease. */
    gate: { mayWrite(): boolean };
    log: Logger;
    /** A full pass again while nothing changes (`dns.controller.resyncMinutes`): re-creates what was removed by hand. */
    resyncMs?: number;
    /** The first wait after a pass that left something undone; it doubles up to a minute (or `resyncMs`, when shorter). */
    retryMs?: number;
    /** How long a deleted provider's instance outlives its endpoints, so it can delete the records it owns (one interval and a margin). */
    providerRemovalDelayMs?: number;
    now?: () => number;
    /**
     * Runs the operations of the desired state (phase C4) at the end of every pass that published it, once the endpoints are
     * applied and pruned; not while the image pin refuses the state. Throws `NotWriterError` like a write.
     */
    operations?: Pick<OperationRunner, "run">;
    /** Called after each pass that ran (not one refused for lack of the Lease), so the status report follows what the pass applied. Must not throw. */
    onPass?: () => void;
}

/**
 * How a pass ended: `done`; `incomplete` (something failed or is still on its way: tried again with backoff);
 * `not_writer` (it may not write, at the start or along the way); `refused` (the state can't be published safely, so
 * nothing was written). `nextAt` is when a deleted provider's removal is due.
 */
export interface PassOutcome {
    result: "done" | "incomplete" | "not_writer" | "refused";
    nextAt?: number;
}

/** What a pass is doing, for its log line when that fails: `read`, `apply`, `delete` or `list`, the kind, and the object. */
type Step = Record<string, string>;

/**
 * Runs one step of a pass: true when it succeeded; false when it failed, which is logged (`reconcile_failed`) and makes
 * the pass incomplete. Losing the right to write is never caught: it ends the pass.
 */
type Attempt = (step: Step, call: () => Promise<unknown>) => Promise<boolean>;

/** A provider uid as the server makes them, and as a label value and name suffix must be (at most 40 characters). */
const PROVIDER_UID: RegExp = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
/** A zone as the server normalizes them: a lowercase domain name of at least two labels (never a top-level domain alone). */
const ZONE: RegExp = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** An object a list returned. It carries the controller's labels: the list selected it by them. A Deployment carries its pod template too. */
interface Listed {
    metadata: { name: string; labels: Record<string, string> };
    spec?: { template: { spec: { containers: { args?: string[] }[] } } };
}

/** A deleted provider's instance that is still there: its Deployment's name and the zones it is filtered to (its `--domain-filter`s). */
interface GoneInstance {
    name: string;
    zones: string[];
}

const DOMAIN_FILTER = "--domain-filter=";

/** An object the API server answered an apply with: all the controller needs from it is its uid. */
interface Applied {
    metadata?: { uid?: string };
}

/**
 * What a provider's Secret is, from its metadata: whether this controller wrote it, the generation it holds (none when
 * the annotation is gone or isn't a number) and the uids of the Deployments that own it.
 */
interface SecretState {
    ours: boolean;
    generation?: number;
    ownerUids: string[];
}

/** What the pod template says about a Secret there whose generation is unknown: no generation the server gives, so the pod rolls once the Secret is rewritten. */
const UNKNOWN_GENERATION = -1;

/**
 * Turns the desired state into the namespace's objects (spec 7.4, 7.5) and keeps them so:
 *
 * - **Per provider config:** the external-dns Deployment, only with the pinned image, and the Secret it reads its
 * credentials from, which the controller writes from the credentials the server sends it. The Secret is fetched and
 * written when it is missing or holds another generation than the config's; the Deployment's pod template carries the
 * generation the Secret already holds, so the pod rolls once new credentials are there, not before.
 * - **Per endpoint set:** its DNSEndpoint.
 * - **Pruning:** a DNSEndpoint it manages that the state no longer has is deleted. A deleted provider's Secret and
 * Deployment go one interval after its endpoints, so its instance can delete what it owns.
 * - **Operations:** once all that is applied, the `OperationRunner` runs the state's operations, whose temporary
 * DNSEndpoints (labelled for their Job, not for an instance) pruning leaves alone.
 *
 * Every write is a server-side apply as `rapidmx-dns-controller` (idempotent) or a delete, each checked against the gate
 * immediately before it. Passes never overlap; a state that arrives during one is applied right after it.
 */
export class Reconciler {
    private readonly resyncMs: number;
    private readonly retryMs: number;
    private readonly maxRetryMs: number;
    private readonly providerRemovalDelayMs: number;
    private readonly now: () => number;
    private readonly removals: Map<string, number> = new Map();
    private state?: DesiredStateV1;
    private passing = false;
    private again = false;
    private stopped = false;
    private timer?: NodeJS.Timeout;
    /** The passes under way, if any: what `stop()` waits for. */
    private draining?: Promise<void>;
    private retryDelayMs: number;

    constructor(private readonly options: ReconcilerOptions) {
        this.resyncMs = options.resyncMs ?? 600000;
        this.retryMs = options.retryMs ?? 15000;
        this.maxRetryMs = Math.max(this.retryMs, Math.min(60000, this.resyncMs));
        this.providerRemovalDelayMs = options.providerRemovalDelayMs ?? 120000;
        this.now = options.now ?? Date.now;
        this.retryDelayMs = this.retryMs;
    }

    /** A new desired state: reconciled now, or right after the pass under way. */
    update(state: DesiredStateV1): void {
        this.state = state;
        this.request();
    }

    /** A pass now with the state it has (the Lease was just taken); nothing before a first state. */
    wake(): void {
        if (this.state) {
            this.request();
        }
    }

    /**
     * Stops: no new pass and no further write in the one under way. Resolves once that pass has ended, so the Lease is
     * released only after its last request was answered: a request still in flight could otherwise land after a successor
     * took the Lease.
     */
    async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.draining;
    }

    private request(): void {
        if (this.stopped) {
            return;
        }
        if (this.passing) {
            this.again = true;
            return;
        }
        clearTimeout(this.timer);
        this.draining = this.drain();
    }

    /** Runs passes until none was asked for meanwhile, then schedules the next. Nothing it throws escapes. */
    private async drain(): Promise<void> {
        this.passing = true;
        let outcome: PassOutcome = { result: "incomplete" };
        try {
            do {
                this.again = false;
                try {
                    outcome = await this.reconcile(this.state as DesiredStateV1);
                } catch (err) {
                    this.options.log.error("reconcile_failed", { step: "pass", error: err });
                    outcome = { result: "incomplete" };
                }
            } while (this.again && !this.stopped);
        } finally {
            this.passing = false;
        }
        if (this.stopped) {
            return;
        }
        if (outcome.result !== "not_writer") {
            this.options.onPass?.();
        }
        let delay: number;
        if (outcome.result === "done" || outcome.result === "refused") {
            this.retryDelayMs = this.retryMs;
            delay = this.resyncMs;
        } else {
            delay = this.retryDelayMs;
            this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.maxRetryMs);
        }
        if (outcome.nextAt !== undefined) {
            delay = Math.min(delay, Math.max(0, outcome.nextAt - this.now()));
        }
        this.timer = setTimeout(() => this.request(), delay);
    }

    /** Throws `NotWriterError` unless it may write now and isn't stopping; asked before every write and before every fetch of credentials. */
    private assertMayWrite(): void {
        if (this.stopped || !this.options.gate.mayWrite()) {
            throw new NotWriterError();
        }
    }

    /** Runs `call` once it has checked, immediately before, that it may write. */
    private async write<T>(call: () => Promise<T>): Promise<T> {
        this.assertMayWrite();
        return call();
    }

    private apply(path: string, manifest: Pick<Manifest, "metadata"> | Pick<SecretManifest, "metadata">): Promise<Applied> {
        return this.write(() => this.options.kube.apply<Applied>(`${path}/${manifest.metadata.name}`, manifest, { fieldManager: FIELD_MANAGER, force: true }));
    }

    /** Deletes `path`; one already gone counts as deleted. */
    private async remove(path: string): Promise<void> {
        try {
            await this.write(() => this.options.kube.delete(path));
        } catch (err) {
            if (!isKubeStatus(err, 404)) {
                throw err;
            }
        }
    }

    private collection(apiPrefix: string, resource: string): string {
        return `${apiPrefix}/namespaces/${this.options.settings.namespace}/${resource}`;
    }

    private list(path: string): Promise<Listed[]> {
        return listManaged<Listed>(this.options.kube, path, this.options.settings);
    }

    /**
     * Why the state can't be published safely, or undefined. Checked whole, before any write, like `parseDesiredState()`:
     * a provider without zones would run with no `--domain-filter` and act on every zone its credentials reach; a zone in
     * two configs would set two instances sharing the owner id against each other (a nested zone is kept out of the
     * parent's instance instead, `nestedZones()`); a credential field name that isn't plain would become an odd Secret key
     * and environment reference.
     */
    private unpublishable(state: DesiredStateV1): string | undefined {
        const uids: Set<string> = new Set();
        const zones: Set<string> = new Set();
        for (const provider of state.providers) {
            if (!PROVIDER_UID.test(provider.uid) || uids.has(provider.uid)) {
                return "a provider uid is malformed or repeated";
            }
            uids.add(provider.uid);
            if (provider.zones.length === 0 || !provider.zones.every((zone) => ZONE.test(zone))) {
                return "a provider has no zones, or a zone that isn't a domain name";
            }
            for (const zone of new Set(provider.zones)) {
                if (zones.has(zone)) {
                    return "a zone is in two provider configs";
                }
                zones.add(zone);
            }
            if (provider.credentials && !provider.credentials.keys.every((key) => CREDENTIAL_FIELD.test(key))) {
                return "a provider's credential field name is malformed";
            }
        }
        const ids: Set<string> = new Set();
        for (const set of state.endpointSets) {
            if (!ENDPOINT_SET_ID.test(set.id) || ids.has(set.id)) {
                return "an endpoint set id is malformed or repeated";
            }
            if (!uids.has(set.providerUid)) {
                return "an endpoint set names a provider the state doesn't have";
            }
            ids.add(set.id);
        }
        return undefined;
    }

    /** The provider's Secret as its metadata tells (never its data), or undefined when there is none. */
    private async readSecret(provider: DnsProviderV1): Promise<SecretState | undefined> {
        let meta: { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string>; ownerReferences?: { kind?: string; uid?: string }[] } };
        try {
            meta = await this.options.kube.getMetadata(`${this.collection("/api/v1", "secrets")}/${credentialsSecretName(this.options.settings, provider.uid)}`);
        } catch (err) {
            if (isKubeStatus(err, 404)) {
                return undefined;
            }
            throw err;
        }
        const generation = Number(meta.metadata?.annotations?.[ANNOTATION_CREDENTIALS_GENERATION]);
        const ownerUids: string[] = (meta.metadata?.ownerReferences ?? []).flatMap((owner) => (owner.kind === "Deployment" && owner.uid ? [owner.uid] : []));
        return { ours: isOurSecret(meta.metadata?.labels, provider.uid), ownerUids, ...(Number.isSafeInteger(generation) ? { generation } : {}) };
    }

    /** The uid of the provider's Deployment as the API server answered the apply with it; a Deployment without one can own nothing. */
    private ownerUid(deployment: Applied): string {
        const uid: string | undefined = deployment.metadata?.uid;
        if (!uid) {
            throw new Error("the Deployment has no uid to own the Secret");
        }
        return uid;
    }

    /** The uid of the provider's Deployment that is there already, when the image pin keeps this pass from applying one; undefined without one. */
    private async existingOwnerUid(provider: DnsProviderV1): Promise<string | undefined> {
        try {
            return this.ownerUid(
                await this.options.kube.getMetadata<Applied>(`${this.collection("/apis/apps/v1", "deployments")}/${deploymentName(this.options.settings, provider.uid)}`)
            );
        } catch (err) {
            if (isKubeStatus(err, 404)) {
                return undefined;
            }
            throw err;
        }
    }

    /**
     * Applies one provider's objects: its Deployment (with the pinned image), whose pod template carries the credentials
     * generation its Secret already holds, then the Secret itself when it is missing, behind, or owned by a Deployment that
     * is not the one just applied (one recreated by hand gets a new uid, and the garbage collector would take the Secret
     * with the old one). True while newer credentials are still on their way.
     */
    private async applyProvider(state: DesiredStateV1, provider: DnsProviderV1, imageAccepted: boolean, step: Step, pendingZones: string[]): Promise<boolean> {
        const { settings } = this.options;
        const wanted: number | undefined = provider.credentials?.generation;
        const secret: SecretState | undefined = await this.readSecret(provider);
        if (wanted !== undefined && secret && !secret.ours) {
            // A name collision: never write over, or run an instance on, a Secret this controller didn't make.
            throw new Error(`the Secret ${credentialsSecretName(settings, provider.uid)} exists but is not this controller's`);
        }
        // A Secret not there yet counts as the config's generation: the pod starts once it appears, without rolling. One there
        // with an unknown generation counts as older than any, so the pod rolls after it is rewritten, not before.
        const held: number | undefined = secret?.generation;
        let deployment: Applied | undefined;
        if (imageAccepted) {
            step.step = "apply";
            step.kind = "Deployment";
            deployment = await this.applyDeployment(state, provider, secret ? (held ?? UNKNOWN_GENERATION) : wanted, pendingZones);
        }
        if (wanted === undefined) {
            // No credentials: no Secret, and one this controller wrote before goes, once the Deployment no longer refers to it.
            if (secret?.ours) {
                if (!deployment) {
                    this.options.log.info("secret_delete_deferred", { providerUid: provider.uid, reason: "the Deployment that refers to the Secret was not updated" });
                    return true;
                }
                step.step = "delete";
                step.kind = "Secret";
                await this.remove(`${this.collection("/api/v1", "secrets")}/${credentialsSecretName(settings, provider.uid)}`);
            }
            return false;
        }
        // A Deployment answered without a uid can't be compared; a Secret that has to be written then is refused (`ownerUid()`).
        const deploymentUid: string | undefined = deployment?.metadata?.uid;
        if (secret && held === wanted && (deploymentUid === undefined || secret.ownerUids.includes(deploymentUid))) {
            return false;
        }
        let ownerUid: string | undefined;
        if (deployment) {
            step.step = "apply";
            step.kind = "Secret";
            ownerUid = this.ownerUid(deployment);
        } else {
            // The image was refused: an instance that is there already can still own the Secret, none leaves it unwritten.
            step.step = "read";
            step.kind = "Deployment";
            ownerUid = await this.existingOwnerUid(provider);
            if (ownerUid === undefined) {
                this.options.log.info("credentials_deferred", { providerUid: provider.uid, reason: "there is no Deployment to own the Secret" });
                return true;
            }
            step.step = "apply";
            step.kind = "Secret";
        }
        const written: boolean = await this.writeCredentials(provider, ownerUid);
        if (written && imageAccepted && secret && held !== wanted) {
            // The Secret held older (or unknown) credentials, and the pod template said so: now that it holds the new ones, this apply rolls the pod.
            step.kind = "Deployment";
            await this.applyDeployment(state, provider, wanted, pendingZones);
        }
        return !written;
    }

    private applyDeployment(state: DesiredStateV1, provider: DnsProviderV1, credentialsGeneration: number | undefined, pendingZones: string[]): Promise<Applied> {
        const { settings } = this.options;
        return this.apply(
            this.collection("/apis/apps/v1", "deployments"),
            externalDnsDeployment(provider, state.ownerId, settings, credentialsGeneration, nestedZones(provider, state.providers, pendingZones))
        );
    }

    /**
     * The deleted providers' instances among `deployments`: one labelled for a uid the state no longer has. Secrets are never
     * listed; the instance is the one mark of a deleted provider. Read from the cluster, not remembered, so a controller that
     * took over the Lease (or restarted) in that interval knows them too.
     */
    private goneInstances(state: DesiredStateV1, deployments: Listed[]): Map<string, GoneInstance> {
        const desired: Set<string> = new Set(state.providers.map((p) => p.uid));
        const gone: Map<string, GoneInstance> = new Map();
        for (const item of deployments) {
            const uid: string = item.metadata.labels[LABEL_PROVIDER];
            if (!desired.has(uid)) {
                const args: string[] = (item.spec?.template.spec.containers ?? []).flatMap((container) => container.args ?? []);
                gone.set(uid, { name: item.metadata.name, zones: args.filter((arg) => arg.startsWith(DOMAIN_FILTER)).map((arg) => arg.slice(DOMAIN_FILTER.length)) });
            }
        }
        return gone;
    }

    /**
     * Fetches the provider's credentials from the server and applies the Secret owned by the Deployment with `ownerUid`.
     * True when the Secret was written. Nothing is written, and the Secret there stays, for a fetch that failed, an answer
     * at another generation than the config's (the next desired state brings the right one) or one that lacks a field the
     * state lists. The values are in memory only for this call and are never logged.
     */
    private async writeCredentials(provider: DnsProviderV1, ownerUid: string): Promise<boolean> {
        const { server, settings, log } = this.options;
        const info = provider.credentials as NonNullable<DnsProviderV1["credentials"]>;
        // A controller that may not write fetches no credentials either.
        this.assertMayWrite();
        const outcome = await server.providerCredentials(provider.uid);
        if (outcome.state !== "ok") {
            log.warn("credentials_fetch_failed", {
                providerUid: provider.uid,
                generation: info.generation,
                state: outcome.state,
                detail: "reason" in outcome ? outcome.reason : outcome.error,
            });
            return false;
        }
        const answer = outcome.value;
        if (answer.providerUid !== provider.uid) {
            log.warn("credentials_fetch_failed", {
                providerUid: provider.uid,
                generation: info.generation,
                state: "invalid",
                detail: "the answer is about another provider",
            });
            return false;
        }
        if (answer.generation !== info.generation) {
            log.warn("credentials_stale", { providerUid: provider.uid, generation: info.generation, answered: answer.generation });
            return false;
        }
        // Fields the state lists that the answer lacks, and fields the server says it couldn't decrypt: names only.
        const unreadable: string[] = [...new Set([...info.keys.filter((key) => !Object.hasOwn(answer.values, key)), ...(answer.unreadable ?? [])])];
        if (unreadable.length > 0) {
            log.warn("credentials_unreadable", { providerUid: provider.uid, generation: info.generation, fields: unreadable });
            return false;
        }
        await this.apply(this.collection("/api/v1", "secrets"), credentialsSecret(provider, answer.values, settings, ownerUid));
        log.info("credentials_written", { providerUid: provider.uid, generation: info.generation });
        return true;
    }

    /**
     * One pass over `state`. Fails per object, not per pass: an object that can't be read or written is logged
     * (`reconcile_failed`), the others still are, and the pass ends `incomplete`. Losing the right to write ends it at once.
     */
    async reconcile(state: DesiredStateV1): Promise<PassOutcome> {
        const { settings, log } = this.options;
        const problem: string | undefined = this.unpublishable(state);
        if (problem !== undefined) {
            log.error("desired_state_unpublishable", { version: state.version, reason: problem });
            return { result: "refused" };
        }
        if (!this.options.gate.mayWrite()) {
            return { result: "not_writer" };
        }
        let failed = false;
        const attempt: Attempt = async (step, call) => {
            try {
                await call();
                return true;
            } catch (err) {
                if (err instanceof NotWriterError) {
                    throw err;
                }
                failed = true;
                log.error("reconcile_failed", { ...step, error: err });
                return false;
            }
        };
        try {
            const imageAccepted: boolean = acceptsExternalDnsImage(settings.externalDnsImage, state.externalDnsImage);
            if (!imageAccepted) {
                // The pin decides what runs; a server asking for another image changes nothing that runs.
                log.error("external_dns_image_refused", { image: state.externalDnsImage, pin: settings.externalDnsImage });
                failed = true;
            }
            // The instances of deleted providers come first: they keep running for an interval, and the instances applied here must
            // stay out of their zones until they are gone. Nothing is applied on a guess when they can't be listed.
            let listedDeployments: Listed[] = [];
            const listed: boolean = await attempt({ step: "list", kind: "Deployment" }, async () => {
                listedDeployments = await this.list(this.collection("/apis/apps/v1", "deployments"));
            });
            const gone: Map<string, GoneInstance> = this.goneInstances(state, listedDeployments);
            const pendingZones: string[] = [...gone.values()].flatMap((instance) => instance.zones);
            const types: Map<string, DnsProviderV1["type"]> = new Map(state.providers.map((p) => [p.uid, p.type]));
            for (const provider of listed ? state.providers : []) {
                const step: Step = { step: "read", kind: "Secret", providerUid: provider.uid };
                await attempt(step, async () => {
                    failed = (await this.applyProvider(state, provider, imageAccepted, step, pendingZones)) || failed;
                });
            }
            const endpoints: string = this.collection("/apis/externaldns.k8s.io/v1alpha1", "dnsendpoints");
            for (const set of state.endpointSets) {
                const manifest: Manifest = dnsEndpoint(set, types.get(set.providerUid) as DnsProviderV1["type"], settings);
                await attempt({ step: "apply", kind: "DNSEndpoint", name: manifest.metadata.name }, () => this.apply(endpoints, manifest));
            }
            let nextAt: number | undefined = listed ? await this.prune(state, attempt, gone) : undefined;
            let pending = false;
            const { operations } = this.options;
            if (operations && imageAccepted) {
                await attempt({ step: "run", kind: "Operation" }, async () => {
                    const outcome = await operations.run(state, () => !this.stopped && this.options.gate.mayWrite());
                    pending = outcome.pending;
                    if (outcome.nextAt !== undefined) {
                        nextAt = Math.min(nextAt ?? outcome.nextAt, outcome.nextAt);
                    }
                });
            }
            return { result: failed || pending ? "incomplete" : "done", ...(nextAt !== undefined ? { nextAt } : {}) };
        } catch (err) {
            if (err instanceof NotWriterError) {
                log.debug("reconcile_interrupted", { reason: "this controller may no longer write" });
                return { result: "not_writer" };
            }
            throw err;
        }
    }

    /**
     * Deletes what the state no longer has; returns when the next removal of a deleted provider is due. Nothing of a
     * deleted provider is removed while its endpoints couldn't all be listed and deleted. `gone` are the deleted providers'
     * instances (`goneInstances()`), listed at the start of the pass.
     */
    private async prune(state: DesiredStateV1, attempt: Attempt, gone: Map<string, GoneInstance>): Promise<number | undefined> {
        const { settings } = this.options;
        const endpoints: string = this.collection("/apis/externaldns.k8s.io/v1alpha1", "dnsendpoints");
        const deployments: string = this.collection("/apis/apps/v1", "deployments");
        let listedEndpoints: Listed[] = [];
        const listed: boolean = await attempt({ step: "list", kind: "DNSEndpoint" }, async () => {
            listedEndpoints = await this.list(endpoints);
        });
        if (!listed) {
            return undefined;
        }

        const wantedEndpoints: Set<string> = new Set(state.endpointSets.map((set: EndpointSetV1) => dnsEndpointName(settings, set.id)));
        // The providers some of whose unwanted endpoints are still there.
        const endpointsLeft: Set<string> = new Set();
        // The temporary endpoints of operations are the OperationRunner's.
        for (const item of listedEndpoints.filter((i) => !wantedEndpoints.has(i.metadata.name) && i.metadata.labels[LABEL_OPERATION] === undefined)) {
            if (!(await attempt({ step: "delete", kind: "DNSEndpoint", name: item.metadata.name }, () => this.remove(`${endpoints}/${item.metadata.name}`)))) {
                endpointsLeft.add(item.metadata.labels[LABEL_PROVIDER]);
            }
        }

        // A provider that came back, or whose instance is gone, starts over if it is deleted again.
        for (const uid of this.removals.keys()) {
            if (!gone.has(uid)) {
                this.removals.delete(uid);
            }
        }
        let nextAt: number | undefined;
        const now: number = this.now();
        for (const [uid, instance] of gone) {
            if (endpointsLeft.has(uid)) {
                continue;
            }
            const since: number = this.removals.get(uid) ?? now;
            this.removals.set(uid, since);
            const due: number = since + this.providerRemovalDelayMs;
            if (now < due) {
                nextAt = Math.min(nextAt ?? due, due);
                continue;
            }
            const step: Step = { step: "delete", kind: "Secret", providerUid: uid };
            if (await attempt(step, () => this.removeProvider(uid, instance.name, deployments, step))) {
                // The zones it was kept out of are the instances' again: a pass of their own applies them without the exclusion.
                if (instance.zones.some((zone) => state.providers.some((p) => nestedZones(p, [], [zone]).length > 0))) {
                    this.again = true;
                }
            }
        }
        return nextAt;
    }

    /**
     * A deleted provider's Secret (only when its labels say it is that provider's), then its instance. The instance goes
     * last: it is the only object that marks the provider as deleted, so a failure before it leaves that mark for the next
     * pass, never a Secret of live credentials nothing points at.
     */
    private async removeProvider(uid: string, deployment: string, deployments: string, step: Step): Promise<void> {
        const { settings, kube, log } = this.options;
        const secret: string = `${this.collection("/api/v1", "secrets")}/${credentialsSecretName(settings, uid)}`;
        const labels: Record<string, string> | undefined = await kube.getMetadata<Listed>(secret).then(
            (meta) => meta.metadata.labels,
            (err: unknown) => {
                if (isKubeStatus(err, 404)) {
                    return undefined;
                }
                throw err;
            }
        );
        if (isOurSecret(labels, uid)) {
            await this.remove(secret);
        }
        step.kind = "Deployment";
        await this.remove(`${deployments}/${deployment}`);
        this.removals.delete(uid);
        log.info("external_dns_removed", { providerUid: uid, deployment: deploymentName(settings, uid) });
    }
}
