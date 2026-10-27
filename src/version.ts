///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "dns-controller";

/**
 * This controller's version, from its own package.json: the nearest one named `dns-controller` above `startDir`. Walks
 * up because the compiled file (`dist/src/`) sits one level deeper than the source (`src/`). The image ships
 * package.json for exactly this. `"unknown"` when none is found.
 */
export function readControllerVersion(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
    let dir: string = startDir;
    for (let depth = 0; depth < 4; depth++) {
        try {
            const pkg: { name?: unknown; version?: unknown } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
            if (pkg.name === PACKAGE_NAME && typeof pkg.version === "string") {
                return pkg.version;
            }
        } catch {
            // No (readable) package.json here: keep walking up.
        }
        dir = dirname(dir);
    }
    return "unknown";
}
