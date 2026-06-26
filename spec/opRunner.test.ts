import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { OpCliNotFoundError, OpInjectAbortedError, OpInjectError, OpRunner } from "../src/opRunner"

/**
 * Writes a small POSIX shell script that mimics `op inject`. Reads the
 * template from the `--in-file` path and, for each line matching
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
                "    --in-file) in_file=\"$2\"; shift 2 ;;",
                "    *) shift ;;",
                "  esac",
                "done",
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

suite("OpRunner.inject", () => {
    test("resolves zero refs without spawning", async () => {
        // Use an obviously missing path so any spawn would fail loudly.
        const result = await new OpRunner("/does/not/exist/should-never-spawn").inject([])
        assert.strictEqual(result.size, 0)
    })

    test("resolves multiple refs in one call", async () => {
        if (process.platform === "win32") {
            return
        }

        const fake = await makeFakeOp("ok")

        try {
            const result = await new OpRunner(fake.path).inject(
                ["op://Vault/Item/a", "op://Vault/Item/b"],
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
        await assert.rejects(
            new OpRunner("/no/such/op-binary").inject(["op://x/y/z"]),
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
            await assert.rejects(
                new OpRunner(fake.path).inject(["op://x/y/z"]),
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
            const controller = new AbortController()
            const promise = new OpRunner(fake.path).inject(
                ["op://x/y/z"],
                { signal: controller.signal },
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

    test("passes --account to op inject when account is set", async () => {
        if (process.platform === "win32") {
            return
        }

        const argLogFile = path.join(os.tmpdir(), `sr-inject-arg-log-${Date.now()}.txt`)

        try {
            const fake = await makeFakeOp("ok", argLogFile)

            try {
                await new OpRunner(fake.path).inject(
                    ["op://Vault/Item/a"],
                    { account: "SOME_ACCOUNT_ID" },
                )
                const log = await fs.readFile(argLogFile, "utf8")
                assert.ok(
                    log.includes("--account SOME_ACCOUNT_ID"),
                    `expected --account SOME_ACCOUNT_ID in args: ${log}`,
                )
            }
            finally {
                await fake.cleanup()
            }
        }
        finally {
            await fs.rm(argLogFile, { force: true })
        }
    })
})

suite("OpRunner.buildRunArgs", () => {
    test("wraps the args with op run --env-file and a -- separator", () => {
        assert.deepStrictEqual(
            new OpRunner("op").buildRunArgs("/tmp/sr/env", ["node", "app.js"]),
            ["op", "run", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })

    test("honors an absolute op path", () => {
        assert.deepStrictEqual(
            new OpRunner("/opt/homebrew/bin/op").buildRunArgs(
                "/tmp/sr/env",
                ["python", "-m", "svc"],
            ),
            [
                "/opt/homebrew/bin/op",
                "run",
                "--env-file=/tmp/sr/env",
                "--",
                "python",
                "-m",
                "svc",
            ],
        )
    })

    test("handles an empty args array", () => {
        assert.deepStrictEqual(
            new OpRunner("op").buildRunArgs("/tmp/sr/env", []),
            ["op", "run", "--env-file=/tmp/sr/env", "--"],
        )
    })

    test("does not mutate the input args", () => {
        const input = ["node", "app.js"]
        const snapshot = [...input]
        new OpRunner("op").buildRunArgs("/tmp/sr/env", input)
        assert.deepStrictEqual(input, snapshot)
    })

    test("preserves arg values verbatim (no quoting or escaping)", () => {
        assert.deepStrictEqual(
            new OpRunner("op").buildRunArgs("/tmp/sr/env", [
                "echo",
                "hello world",
                "a'b\"c",
            ]),
            [
                "op",
                "run",
                "--env-file=/tmp/sr/env",
                "--",
                "echo",
                "hello world",
                "a'b\"c",
            ],
        )
    })

    test("inserts --account after 'run' and before --env-file when account is provided", () => {
        assert.deepStrictEqual(
            new OpRunner("op").buildRunArgs("/tmp/sr/env", ["node", "app.js"], "my-account"),
            ["op", "run", "--account", "my-account", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })

    test("omits --account when account is undefined", () => {
        assert.deepStrictEqual(
            new OpRunner("op").buildRunArgs("/tmp/sr/env", ["node", "app.js"], undefined),
            ["op", "run", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })
})
