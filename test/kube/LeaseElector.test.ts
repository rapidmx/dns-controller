import { KubeError, type KubeClient } from "../../src/kube/KubeClient.js";
import { LeaseElector, microTime, type Lease } from "../../src/kube/LeaseElector.js";
import { Logger } from "../../src/log.js";

const PATH = "/apis/coordination.k8s.io/v1/namespaces/rapidmx/leases";

/** An in-memory Lease API with resourceVersion conflicts, like the real API server. */
class FakeLeaseApi {
    lease?: Lease;
    version = 0;
    failNext?: { method: "get" | "create" | "replace"; error: Error };
    calls: string[] = [];

    private maybeFail(method: "get" | "create" | "replace"): void {
        if (this.failNext?.method === method) {
            const { error } = this.failNext;
            this.failNext = undefined;
            throw error;
        }
    }

    readonly client = {
        get: async (path: string): Promise<Lease> => {
            this.calls.push(`GET ${path}`);
            this.maybeFail("get");
            if (!this.lease) {
                throw new KubeError("not found", 404, "NotFound");
            }
            return structuredClone(this.lease);
        },
        create: async (path: string, body: Lease): Promise<Lease> => {
            this.calls.push(`POST ${path}`);
            this.maybeFail("create");
            if (this.lease) {
                throw new KubeError("exists", 409, "AlreadyExists");
            }
            this.lease = { ...structuredClone(body), metadata: { ...body.metadata, resourceVersion: String(++this.version) } };
            return structuredClone(this.lease);
        },
        replace: async (path: string, body: Lease): Promise<Lease> => {
            this.calls.push(`PUT ${path}`);
            this.maybeFail("replace");
            if (!this.lease || body.metadata.resourceVersion !== this.lease.metadata.resourceVersion) {
                throw new KubeError("conflict", 409, "Conflict");
            }
            this.lease = { ...structuredClone(body), metadata: { ...body.metadata, resourceVersion: String(++this.version) } };
            return structuredClone(this.lease);
        },
    };

    /** Another pod renews the Lease (a new record). */
    renewBy(identity: string, at: number): void {
        this.lease = {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: { name: "mail-dns-controller", namespace: "rapidmx", resourceVersion: String(++this.version) },
            spec: { holderIdentity: identity, leaseDurationSeconds: 30, renewTime: microTime(at), leaseTransitions: 3 },
        };
    }
}

describe("LeaseElector", () => {
    let api: FakeLeaseApi;
    let clock: number;
    let lines: string[];
    let acquired: number;
    let lost: number;

    function elector(identity = "pod-a", extra: { onAcquired?: () => void; onLost?: () => void } = {}): LeaseElector {
        return new LeaseElector({
            kube: api.client as unknown as KubeClient,
            namespace: "rapidmx",
            name: "mail-dns-controller",
            identity,
            leaseDurationSeconds: 30,
            renewIntervalSeconds: 10,
            log: new Logger("debug", (l) => lines.push(l)),
            onAcquired: extra.onAcquired ?? (() => acquired++),
            onLost: extra.onLost ?? (() => lost++),
            now: () => clock,
        });
    }

    const messages = () => lines.map((l) => JSON.parse(l).msg);

    beforeEach(() => {
        api = new FakeLeaseApi();
        clock = Date.parse("2026-10-27T10:00:00.000Z");
        lines = [];
        acquired = 0;
        lost = 0;
    });

    it("formats MicroTime with microseconds", () => {
        expect(microTime(Date.parse("2026-10-27T10:00:00.123Z"))).toBe("2026-10-27T10:00:00.123000Z");
    });

    it("creates a missing Lease and holds it", async () => {
        const e = elector();
        expect(e.holds()).toBe(false);
        expect(await e.tryAcquireOrRenew()).toBe(true);
        expect(e.holds()).toBe(true);
        expect(acquired).toBe(1);
        expect(api.lease?.spec).toEqual({
            holderIdentity: "pod-a",
            leaseDurationSeconds: 30,
            acquireTime: "2026-10-27T10:00:00.000000Z",
            renewTime: "2026-10-27T10:00:00.000000Z",
            leaseTransitions: 0,
        });
        expect(api.lease?.metadata.labels).toEqual({ "app.kubernetes.io/managed-by": "rapidmx-dns-controller" });
        expect(api.calls).toEqual([`GET ${PATH}/mail-dns-controller`, `POST ${PATH}`]);
        expect(messages()).toEqual(["lease_acquired"]);
    });

    it("renews its own Lease, keeping the acquire time and transitions", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        clock += 10000;
        expect(await e.tryAcquireOrRenew()).toBe(true);
        expect(api.lease?.spec.acquireTime).toBe("2026-10-27T10:00:00.000000Z");
        expect(api.lease?.spec.renewTime).toBe("2026-10-27T10:00:10.000000Z");
        expect(api.lease?.spec.leaseTransitions).toBe(0);
        expect(acquired).toBe(1);
    });

    it("waits while another holder's record keeps changing, even if its renewTime looks old", async () => {
        const e = elector();
        // The other pod's clock is an hour behind: its renewTime looks expired, but the record is fresh to us.
        api.renewBy("pod-b", clock - 3600000);
        expect(await e.tryAcquireOrRenew()).toBe(false);
        clock += 25000;
        api.renewBy("pod-b", clock - 3600000);
        expect(await e.tryAcquireOrRenew()).toBe(false);
        clock += 25000;
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(api.lease?.spec.holderIdentity).toBe("pod-b");
    });

    it("takes over a Lease whose record has not changed for a whole duration on its own clock", async () => {
        const e = elector();
        api.renewBy("pod-b", clock);
        expect(await e.tryAcquireOrRenew()).toBe(false);
        clock += 30000;
        expect(await e.tryAcquireOrRenew()).toBe(true);
        expect(api.lease?.spec).toMatchObject({
            holderIdentity: "pod-a",
            acquireTime: "2026-10-27T10:00:30.000000Z",
            leaseTransitions: 4,
        });
    });

    it("takes over a released Lease (empty holder) at once, using the Lease's own duration when it has none", async () => {
        const e = elector();
        api.renewBy("", clock);
        delete api.lease.spec.holderIdentity;
        delete api.lease.spec.leaseDurationSeconds;
        expect(await e.tryAcquireOrRenew()).toBe(true);
    });

    it("uses its configured duration when another holder's Lease has none, and tolerates missing fields", async () => {
        const e = elector();
        api.renewBy("pod-b", clock);
        delete api.lease.spec.leaseDurationSeconds;
        delete api.lease.spec.renewTime;
        delete api.lease.spec.leaseTransitions;
        delete api.lease.metadata.resourceVersion;
        expect(await e.tryAcquireOrRenew()).toBe(false);
        clock += 30000;
        api.lease.metadata.resourceVersion = undefined;
        expect(await e.tryAcquireOrRenew()).toBe(true);
        expect(api.lease?.spec.leaseTransitions).toBe(1);
    });

    it("loses the race to create the Lease", async () => {
        const e = elector();
        api.failNext = { method: "create", error: new KubeError("exists", 409, "AlreadyExists") };
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(JSON.parse(lines[0]).level).toBe("debug");
    });

    it("warns when the Lease cannot be created for another reason", async () => {
        const e = elector();
        api.failNext = { method: "create", error: new KubeError("forbidden", 403, "Forbidden") };
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(JSON.parse(lines[0])).toMatchObject({ level: "warn", msg: "lease_create_failed" });
    });

    it("keeps writing through one failed renewal, then stops once its last renewal is two thirds of a duration old", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        clock += 10000;
        api.failNext = { method: "get", error: new KubeError("unavailable", 503) };
        expect(await e.tryAcquireOrRenew()).toBe(true);
        expect(e.holds()).toBe(true);
        clock += 10000;
        api.failNext = { method: "replace", error: new KubeError("unavailable", 503) };
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(e.holds()).toBe(false);
        expect(lost).toBe(1);
        expect(messages()).toEqual(["lease_acquired", "lease_read_failed", "lease_update_failed", "lease_lost"]);
    });

    it("stops writing at once when another pod is seen holding the Lease", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        api.renewBy("pod-b", clock);
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(e.holds()).toBe(false);
        expect(lost).toBe(1);
    });

    it("stops writing at once when its renewal hits a conflict", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        api.failNext = { method: "replace", error: new KubeError("conflict", 409, "Conflict") };
        expect(await e.tryAcquireOrRenew()).toBe(false);
        expect(lost).toBe(1);
        expect(JSON.parse(lines[1]).level).toBe("debug");
    });

    it("renews on a timer until stopped, then releases the Lease", async () => {
        vi.useFakeTimers();
        try {
            const e = elector();
            e.start();
            e.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(e.holds()).toBe(true);
            clock += 10000;
            await vi.advanceTimersByTimeAsync(10000);
            expect(api.lease?.spec.renewTime).toBe("2026-10-27T10:00:10.000000Z");
            await e.stop();
            expect(api.lease?.spec).toMatchObject({ holderIdentity: "", leaseDurationSeconds: 1 });
            expect(e.holds()).toBe(false);
            expect(lost).toBe(1);
            const calls = api.calls.length;
            await vi.advanceTimersByTimeAsync(30000);
            expect(api.calls.length).toBe(calls);
            expect(messages()).toContain("lease_released");
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not reschedule when stopped during an attempt", async () => {
        vi.useFakeTimers();
        try {
            const e = elector();
            e.start();
            await e.stop();
            await vi.advanceTimersByTimeAsync(20000);
            expect(api.calls).toEqual([`GET ${PATH}/mail-dns-controller`, `POST ${PATH}`]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does nothing on stop when it does not hold the Lease", async () => {
        const e = elector();
        await e.stop();
        expect(api.calls).toEqual([]);
        expect(lost).toBe(0);
    });

    it("leaves the Lease alone on stop when someone else took it meanwhile", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        api.renewBy("pod-b", clock);
        await e.stop();
        expect(api.lease?.spec.holderIdentity).toBe("pod-b");
    });

    it("warns when releasing fails", async () => {
        const e = elector();
        await e.tryAcquireOrRenew();
        api.failNext = { method: "replace", error: new KubeError("unavailable", 503) };
        await e.stop();
        expect(messages()).toContain("lease_release_failed");
    });

    it("works without callbacks and with the real clock", async () => {
        const e = new LeaseElector({
            kube: api.client as unknown as KubeClient,
            namespace: "rapidmx",
            name: "mail-dns-controller",
            identity: "pod-a",
            leaseDurationSeconds: 30,
            renewIntervalSeconds: 10,
            log: new Logger("error", () => undefined),
        });
        expect(await e.tryAcquireOrRenew()).toBe(true);
        await e.stop();
        expect(api.lease?.spec.holderIdentity).toBe("");
        expect(await e.tryAcquireOrRenew()).toBe(true);
        api.renewBy("pod-b", Date.now());
        expect(await e.tryAcquireOrRenew()).toBe(false);
    });
});
