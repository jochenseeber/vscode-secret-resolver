import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ConsoleLogger } from "../src/logger"
import { OpCliError, OpCliNotFoundError, OpRunner } from "../src/opRunner"
import { ResolverCache } from "../src/resolverCache"
import { SecretCache } from "../src/secretCache"
import {
    NullTokenResolver,
    TagTokenResolver,
    TokenCredentialMissingError,
    TokenNotFoundError,
} from "../src/tokenResolver"

/**
 * Writes a fake `op` binary that handles `item list` and `item get` calls.
 * `listResult` is the JSON the fake returns for `item list`.
 * `getResult` is the JSON it returns for `item get`.
 * Pass `"fail"` for either to make that command exit non-zero.
 * Pass `"slow"` for `listResult` to sleep (cancellation test).
 * When `argLogFile` is set, the fake appends `$@` to that file on each call.
 * Handles an optional leading `--account <id>` global flag.
 */
async function makeFakeOp(options: {
    listResult: string | "fail" | "slow"
    getResult?: string | "fail"
    argLogFile?: string
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-tok-"))
    const file = path.join(dir, "op")

    const listBlock = options.listResult === "fail"
        ? `echo 'fake op: list error' >&2\nexit 1`
        : options.listResult === "slow"
        ? `sleep 5\necho '[]'`
        : `printf '%s' ${JSON.stringify(options.listResult)}`

    const getBlock = !options.getResult
        ? `echo '[]'`
        : options.getResult === "fail"
        ? `echo 'fake op: get error' >&2\nexit 1`
        : `printf '%s' ${JSON.stringify(options.getResult)}`

    const logLine = options.argLogFile
        ? `echo "$@" >> ${JSON.stringify(options.argLogFile)}`
        : ""

    const body = [
        "#!/usr/bin/env bash",
        logLine,
        "# Skip optional leading --account <id>",
        "while [[ \"$1\" == \"--account\" ]]; do shift; shift; done",
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

suite("NullTokenResolver", () => {
    test("resolve returns null", async () => {
        const resolver = new NullTokenResolver()
        const result = await resolver.resolve(undefined)
        assert.strictEqual(result, null)
    })

    test("ignores accountId and signal", async () => {
        const resolver = new NullTokenResolver()
        const controller = new AbortController()
        const result = await resolver.resolve("some-account", controller.signal)
        assert.strictEqual(result, null)
    })
})

suite("TagTokenResolver", () => {
    test("resolves token from vault and caches it", async () => {
        if (process.platform === "win32") return

        const listJson = JSON.stringify([{ id: "item-abc", vault: { id: "vault-xyz" } }])
        const getJson = JSON.stringify([{ value: "token-value" }])
        const fake = await makeFakeOp({ listResult: listJson, getResult: getJson })

        try {
            const cache = new ResolverCache(new SecretCache())
            const token = await new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger())
                .resolve(undefined)
            assert.strictEqual(token, "token-value")
            // Second call must return from cache (no extra CLI spawns needed).
            const token2 = await new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger())
                .resolve(undefined)
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
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new TagTokenResolver("missing-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(
                    undefined,
                ),
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
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(undefined),
                (err) => err instanceof TokenCredentialMissingError,
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws OpCliNotFoundError when binary does not exist", async () => {
        const cache = new ResolverCache(new SecretCache())
        await assert.rejects(
            new TagTokenResolver("my-tag", new OpRunner("/no/such/op-binary"), cache, new ConsoleLogger()).resolve(
                undefined,
            ),
            (err) => err instanceof OpCliNotFoundError,
        )
    })

    test("throws OpCliError on non-zero exit from op item list", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "fail" })

        try {
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(undefined),
                (err) => err instanceof OpCliError,
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
            const cache = new ResolverCache(new SecretCache())
            await new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(undefined)

            // Replace op binary with something that always fails — if it were
            // called, the test would throw.
            const badFake = await makeFakeOp({ listResult: "fail" })

            try {
                const token = await new TagTokenResolver(
                    "my-tag",
                    new OpRunner(badFake.path),
                    cache,
                    new ConsoleLogger(),
                ).resolve(undefined)
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
            const cache = new ResolverCache(new SecretCache())
            const controller = new AbortController()
            const promise = new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(
                undefined,
                controller.signal,
            )
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
                const cache = new ResolverCache(new SecretCache())
                await new TagTokenResolver("my-tag", new OpRunner(fake.path), cache, new ConsoleLogger()).resolve(
                    "SOME_ACCOUNT_ID",
                )
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
