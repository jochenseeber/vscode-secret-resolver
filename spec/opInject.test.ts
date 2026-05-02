import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DefaultOpInjectRunner, OpCliNotFoundError, OpInjectAbortedError, OpInjectError } from "../src/opInject"

/**
 * Writes a small POSIX shell script that mimics `op inject`. Reads the
 * file passed via `--in-file`/`-i` and, for each line matching
 * `{{ op://... }}`, prints `RESOLVED:<ref>`. Other lines pass through.
 * Behaviors: "ok" resolves, "fail" exits non-zero, "slow" sleeps.
 * When `argLogFile` is set, the fake appends `$@` to that file.
 */
async function makeFakeOp(
    behavior: "ok" | "fail" | "slow",
    argLogFile?: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-"))
    const file = path.join(dir, "op")
    let body: string

    const logLine = argLogFile ? `echo "$@" >> ${JSON.stringify(argLogFile)}` : ""

    switch (behavior) {
        case "ok":
            body = [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                logLine,
                "in_file=\"\"",
                "while [[ $# -gt 0 ]]; do",
                "  case \"$1\" in",
                "    --in-file|-i) in_file=\"$2\"; shift 2 ;;",
                "    *) shift ;;",
                "  esac",
                "done",
                "if [[ -z \"$in_file\" ]]; then",
                "  echo 'fake op: missing --in-file' >&2",
                "  exit 1",
                "fi",
                "while IFS= read -r line; do",
                "  if [[ \"$line\" =~ \\{\\{[[:space:]]*op://([^[:space:]]+)[[:space:]]*\\}\\} ]]; then",
                "    printf 'RESOLVED:%s\\n' \"${BASH_REMATCH[1]}\"",
                "  else",
                "    printf '%s\\n' \"$line\"",
                "  fi",
                "done < \"$in_file\"",
            ].join("\n")
            break
        case "fail":
            body = [
                "#!/usr/bin/env bash",
                "echo 'simulated failure: not signed in' >&2",
                "exit 1",
            ].join("\n")
            break
        case "slow":
            body = [
                "#!/usr/bin/env bash",
                "sleep 5",
                "echo 'late'",
            ].join("\n")
            break
    }

    await fs.writeFile(file, body, "utf8")
    await fs.chmod(file, 0o755)

    return {
        path: file,
        cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    }
}

suite("DefaultOpInjectRunner", () => {
    test("resolves zero refs without spawning", async () => {
        const runner = new DefaultOpInjectRunner()
        // Use an obviously missing path so any spawn would fail loudly.
        const result = await runner.resolve(
            [],
            "/does/not/exist/should-never-spawn",
        )
        assert.strictEqual(result.size, 0)
    })

    test("resolves multiple refs in one call", async () => {
        if (process.platform === "win32") {
            return
        }

        const fake = await makeFakeOp("ok")

        try {
            const runner = new DefaultOpInjectRunner()
            const result = await runner.resolve(
                ["op://Vault/Item/a", "op://Vault/Item/b"],
                fake.path,
            )
            assert.deepStrictEqual(
                Object.fromEntries(result),
                {
                    "op://Vault/Item/a": "RESOLVED:Vault/Item/a",
                    "op://Vault/Item/b": "RESOLVED:Vault/Item/b",
                },
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("translates ENOENT into OpCliNotFoundError", async () => {
        const runner = new DefaultOpInjectRunner()
        await assert.rejects(
            runner.resolve(["op://x/y/z"], "/no/such/op-binary"),
            (err) =>
                err instanceof OpCliNotFoundError
                && (err as OpCliNotFoundError).opPath === "/no/such/op-binary",
        )
    })

    test("translates non-zero exit into OpInjectError carrying stderr", async () => {
        if (process.platform === "win32") {
            return
        }

        const fake = await makeFakeOp("fail")

        try {
            const runner = new DefaultOpInjectRunner()
            await assert.rejects(
                runner.resolve(["op://x/y/z"], fake.path),
                (err) => {
                    if (!(err instanceof OpInjectError)) {
                        return false
                    }

                    return err.stderr.includes("not signed in")
                },
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("translates abort into OpInjectAbortedError", async () => {
        if (process.platform === "win32") {
            return
        }

        const fake = await makeFakeOp("slow")

        try {
            const runner = new DefaultOpInjectRunner()
            const controller = new AbortController()
            const promise = runner.resolve(
                ["op://x/y/z"],
                fake.path,
                controller.signal,
            )
            // Abort before the 5s sleep finishes.
            setTimeout(() => controller.abort(), 50)
            await assert.rejects(
                promise,
                (err) => err instanceof OpInjectAbortedError,
            )
        }
        finally {
            await fake.cleanup()
        }
    })
})
