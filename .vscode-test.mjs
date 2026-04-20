import { dirname, resolve } from "node:path";

import { defineConfig } from "@vscode/test-cli";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

function readExactVscodeVersion() {
    const pkg = JSON.parse(
        readFileSync(resolve(ROOT, "package.json"), "utf8"),
    );
    const version = /\d+\.\d+\.\d+/.exec(pkg.engines?.vscode ?? "")?.[0];

    if (!version) {
        throw new Error(
            "Could not determine an exact VS Code test version from package.json engines.vscode.",
        );
    }

    return version;
}

export default defineConfig({
    files: "build/test/test/integration/**/*.test.js",
    version: readExactVscodeVersion(),
    mocha: {
        ui: "tdd",
        timeout: 20000,
    },
});
