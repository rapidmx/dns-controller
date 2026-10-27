const { runMain } = vi.hoisted(() => ({ runMain: vi.fn(async () => undefined) }));

vi.mock("../src/index.js", () => ({ runMain }));

describe("main", () => {
    it("runs the process with the real environment", async () => {
        await import("../src/main.js");
        expect(runMain).toHaveBeenCalledTimes(1);
        expect(runMain).toHaveBeenCalledWith();
    });
});
