import { OperationLedger } from "../../src/reconcile/OperationLedger.js";

describe("OperationLedger", () => {
    it("holds the latest result of each operation, with its message when there is one", () => {
        const ledger = new OperationLedger();
        ledger.record("op-1", "running");
        expect(ledger.get("op-1")).toEqual({ state: "running" });
        ledger.record("op-1", "failed", "no access to the zone");
        expect(ledger.get("op-1")).toEqual({ state: "failed", message: "no access to the zone" });
        expect(ledger.get("op-2")).toBeUndefined();
    });

    it("forgets the results of the operations that aren't kept", () => {
        const ledger = new OperationLedger();
        ledger.record("op-1", "succeeded");
        ledger.record("op-2", "succeeded");
        ledger.retain(["op-2", "op-3"]);
        expect(ledger.get("op-1")).toBeUndefined();
        expect(ledger.get("op-2")).toEqual({ state: "succeeded" });
    });

    it("forgets every result when cleared", () => {
        const ledger = new OperationLedger();
        ledger.record("op-1", "running");
        ledger.record("op-2", "running");
        ledger.clear();
        expect([ledger.get("op-1"), ledger.get("op-2")]).toEqual([undefined, undefined]);
    });
});
