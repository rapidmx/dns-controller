import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readControllerVersion } from "../src/version.js";

describe("readControllerVersion", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "dns-controller-version-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("finds this repository's package.json from the source directory", () => {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        expect(readControllerVersion()).toBe(pkg.version);
    });

    it("walks up past other packages and unreadable files to the dns-controller package.json", () => {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dns-controller", version: "1.2.3" }));
        mkdirSync(join(dir, "dist", "src"), { recursive: true });
        writeFileSync(join(dir, "dist", "package.json"), JSON.stringify({ name: "other", version: "9.9.9" }));
        writeFileSync(join(dir, "dist", "src", "package.json"), "{ not json");
        expect(readControllerVersion(join(dir, "dist", "src"))).toBe("1.2.3");
    });

    it("ignores a dns-controller package.json without a version and gives up after a few levels", () => {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dns-controller" }));
        expect(readControllerVersion(dir)).toBe("unknown");
        const deep = join(dir, "a", "b", "c", "d", "e");
        mkdirSync(deep, { recursive: true });
        writeFileSync(join(dir, "a", "package.json"), JSON.stringify({ name: "dns-controller", version: "1.0.0" }));
        expect(readControllerVersion(deep)).toBe("unknown");
    });
});
