import * as assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"

import { OpCliNotFoundError, OpInjectError } from "../src/opInject"
import { resolveTokenForTag, TokenCredentialMissingError, TokenNotFoundError } from "../src/tokenResolver"

import { promises as fs } from "node:fs"
import { SecretCache } from "../src/secretCache"

/**
 * Writes a fake `op` binary that handles `item list` and `item get` calls.
 * `listResult` is the JSON the fake returns for `item list`.
 * `getResult` is the JSON it returns for `item get`.
 * Pass `"fail"` for either to make that command exit non-zero.
 * Pass `"slow"` for `listResult` to sleep (cancellation test).
 * When `argLogFile` is set, the fake appends `$@` to that file on each call.
 */
async function makeFakeOp(opts: {
    listResult: string | "fail" | "slow"
    getResult?: string | "fail"
    argLogFile?: string
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-tok-"))
    const file = path.join(dir, "op")

    const listBlock = opts.listResult === "fail"
        ? `echo 'fake op: list error' >&2\nexit 1`
        : opts.listResult === "slow"
        ? `sleep 5\necho '[]'`
        : `printf '%s' ${JSON.stringify(opts.listResult)}`

    const getBlock = !opts.getResult
        ? `echo '[]'`
        : opts.getResult === "fail"
        ? `echo 'fake op: get error' >&2\nexit 1`
        : `printf '%s' ${JSON.stringify(opts.getResult)}`

    const logLine = opts.argLogFile
        ? `echo "$@" >> ${JSON.stringify(opts.argLogFile)}`
        : ""

    const body = [
        "#!/usr/bin/env bash",
        logLine,
        "subcmd=\"$1\"; shift",
        "if [[ \"$subcmd\" == \"item\" ]]; then",
        "  subcmd2=\"$1\"; shift",
        "  if [[ \"$subcmd2\" == \"list\" ]]; then",
        `    ${listBlock}`,
        "  elif [[ \"$subcmd2\" == \"get\" ]]; then",
        `    ${getBlock}`,
        "  fi",
        "fi",
    ].join("\n")

    await fs.writeFile(file, body, "utf8")
    await fs.chmod(file, 0o755)
    return { path: file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

suite("resolveTokenForTag", () => {
    test("resolves token from vault and caches it", async () => {
        if (process.platform === "win32") return

        const listJson = JSON.stringify([{ id: "item-abc", vault: { id: "vault-xyz" } }])
        const getJson = JSON.stringify([{ value: "token-value" }])
        const fake = await makeFakeOp({ listResult: listJson, getResult: getJson })

        try {
            const cache = new SecretCache()
            const token = await resolveTokenForTag("my-tag", fake.path, cache)
            assert.strictEqual(token, "token-value")
            // Second call must return from cache (no extra CLI spawns needed).
            const token2 = await resolveTokenForTag("my-tag", fake.path, cache)
            assert.strictEqual(token2, "token-value")
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws TokenNotFoundError when item list is empty", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "[]" })

        try {
            const cache = new SecretCache()
            await assert.rejects(
                resolveTokenForTag("missing-tag", fake.path, cache),
                (err) =>
                    err instanceof TokenNotFoundError
                    && (err as TokenNotFoundError).message.includes("missing-tag"),
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws TokenCredentialMissingError when credential field is absent", async () => {
        if (process.platform === "win32") return

        const listJson = JSON.stringify([{ id: "item-abc", vault: { id: "vault-xyz" } }])
        const getJson = JSON.stringify([{ label: "username", value: "" }])
        const fake = await makeFakeOp({ listResult: listJson, getResult: getJson })

        try {
            const cache = new SecretCache()
            await assert.rejects(
                resolveTokenForTag("my-tag", fake.path, cache),
                (err) => err instanceof TokenCredentialMissingError,
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws OpCliNotFoundError when binary does not exist", async () => {
        const cache = new SecretCache()
        await assert.rejects(
            resolveTokenForTag("my-tag", "/no/such/op-binary", cache),
            (err) => err instanceof OpCliNotFoundError,
        )
    })

    test("throws OpInjectError on non-zero exit from op item list", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "fail" })

        try {
            const cache = new SecretCache()
            await assert.rejects(
                resolveTokenForTag("my-tag", fake.path, cache),
                (err) => err instanceof OpInjectError,
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns cached value without spawning op on second call", async () => {
        if (process.platform === "win32") return

        const listJson = JSON.stringify([{ id: "item-abc", vault: { id: "vault-xyz" } }])
        const getJson = JSON.stringify([{ value: "cached-token" }])
        const fake = await makeFakeOp({ listResult: listJson, getResult: getJson })

        try {
            const cache = new SecretCache()
            await resolveTokenForTag("my-tag", fake.path, cache)

            // Replace op binary with something that always fails — if it were
            // called, the test would throw.
            const badFake = await makeFakeOp({ listResult: "fail" })

            try {
                const token = await resolveTokenForTag("my-tag", badFake.path, cache)
                assert.strictEqual(token, "cached-token")
            }
            finally {
                await badFake.cleanup()
            }
        }
        finally {
            await fake.cleanup()
        }
    })

    test("propagates AbortSignal cancellation", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "slow" })

        try {
            const cache = new SecretCache()
            const controller = new AbortController()
            const promise = resolveTokenForTag("my-tag", fake.path, cache, controller.signal)
            setTimeout(() => controller.abort(), 50)
            await assert.rejects(promise)
        }
        finally {
            await fake.cleanup()
        }
    })

    test("passes --account to op item list and op item get when account is set", async () => {
        if (process.platform === "win32") return

        const argLogFile = path.join(os.tmpdir(), `sr-arg-log-${Date.now()}.txt`)

        try {
            const listJson = JSON.stringify([{ id: "item-abc", vault: { id: "vault-xyz" } }])
            const getJson = JSON.stringify([{ value: "token-value" }])
            const fake = await makeFakeOp({ listResult: listJson, getResult: getJson, argLogFile })

            try {
                const cache = new SecretCache()
                await resolveTokenForTag("my-tag", fake.path, cache, undefined, "SOME_ACCOUNT_ID")
                const log = await fs.readFile(argLogFile, "utf8")
                const lines = log.trim().split("\n")
                assert.ok(lines.length >= 2, "expected two log lines (list + get)")

                for (const line of lines) {
                    assert.ok(
                        line.includes("--account SOME_ACCOUNT_ID"),
                        `expected --account SOME_ACCOUNT_ID in args: ${line}`,
                    )
                }
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
