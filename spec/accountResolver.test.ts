import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
    AccountNotFoundError,
    EmailAccountResolver,
    GitConfigAccountResolver,
    GitEmailNotFoundError,
} from "../src/accountResolver"
import { GitRunner } from "../src/gitRunner"
import { OpCliError, OpCliNotFoundError, OpRunner } from "../src/opRunner"
import { ResolverCache } from "../src/resolverCache"
import { SecretCache } from "../src/secretCache"

/**
 * Fake `op` binary for `account list` calls.
 * `listResult`: JSON to emit, `"fail"` to exit non-zero, `"slow"` to sleep.
 * Handles an optional leading `--account <id>` global flag.
 */
async function makeFakeOp(options: {
    listResult: string | "fail" | "slow"
    argLogFile?: string
}): Promise<{ path: string; dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-acct-"))
    const file = path.join(dir, "op")

    const listBlock = options.listResult === "fail"
        ? `echo 'fake op: list error' >&2\nexit 1`
        : options.listResult === "slow"
        ? `sleep 5\necho '[]'`
        : `printf '%s' ${JSON.stringify(options.listResult)}`

    const logLine = options.argLogFile
        ? `echo "$@" >> ${JSON.stringify(options.argLogFile)}`
        : ""

    const body = [
        "#!/usr/bin/env bash",
        logLine,
        "# Skip optional leading --account <id>",
        "while [[ \"$1\" == \"--account\" ]]; do shift; shift; done",
        "subcmd=\"$1\"; shift",
        "if [[ \"$subcmd\" == \"account\" ]]; then",
        "  subcmd2=\"$1\"; shift",
        "  if [[ \"$subcmd2\" == \"list\" ]]; then",
        `    ${listBlock}`,
        "  fi",
        "fi",
    ].join("\n")

    await fs.writeFile(file, body, "utf8")
    await fs.chmod(file, 0o755)
    return { path: file, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

/**
 * Fake `git` binary. Returns `userEmail` for `config --get user.email`,
 * or exits non-zero when `"fail"`.
 */
async function makeFakeGit(options: {
    userEmail: string | "fail"
    argLogFile?: string
}): Promise<{ path: string; dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-git-"))
    const file = path.join(dir, "git")

    const emailBlock = options.userEmail === "fail"
        ? `echo 'fake git: no email' >&2\nexit 1`
        : `printf '%s' ${JSON.stringify(options.userEmail)}`

    const logLine = options.argLogFile
        ? `echo "$@" >> ${JSON.stringify(options.argLogFile)}`
        : ""

    const body = [
        "#!/usr/bin/env bash",
        logLine,
        "# Consume all -C <dir> pairs",
        "while [[ \"$1\" == \"-C\" ]]; do shift; shift; done",
        "subcmd=\"$1\"; shift",
        "if [[ \"$subcmd\" == \"config\" ]]; then",
        `  ${emailBlock}`,
        "fi",
    ].join("\n")

    await fs.writeFile(file, body, "utf8")
    await fs.chmod(file, 0o755)
    return { path: file, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

const ACCOUNTS_JSON = JSON.stringify([
    {
        url: "my.1password.com",
        email: "user@example.com",
        user_uuid: "user-uuid-1",
        account_uuid: "acct-uuid-1",
    },
    {
        url: "my.1password.com",
        email: "Other@Example.COM",
        user_uuid: "user-uuid-2",
        account_uuid: "acct-uuid-2",
    },
])

suite("resolveAccountForEmail", () => {
    test("resolves account_uuid from op account list", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            const uuid = await new EmailAccountResolver("user@example.com", new OpRunner(fake.path), cache).resolve()
            assert.strictEqual(uuid, "acct-uuid-1")
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns cached account_uuid on second call without spawning op again", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            await new EmailAccountResolver("user@example.com", new OpRunner(fake.path), cache).resolve()

            const badFake = await makeFakeOp({ listResult: "fail" })

            try {
                const uuid = await new EmailAccountResolver("user@example.com", new OpRunner(badFake.path), cache)
                    .resolve()
                assert.strictEqual(uuid, "acct-uuid-1")
            }
            finally {
                await badFake.cleanup()
            }
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws AccountNotFoundError when no account matches", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new EmailAccountResolver("nobody@example.com", new OpRunner(fake.path), cache).resolve(),
                (err) =>
                    err instanceof AccountNotFoundError
                    && (err as AccountNotFoundError).message.includes("nobody@example.com"),
            )
        }
        finally {
            await fake.cleanup()
        }
    })

    test("email matching is case-insensitive", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            const uuid = await new EmailAccountResolver("OTHER@EXAMPLE.COM", new OpRunner(fake.path), cache).resolve()
            assert.strictEqual(uuid, "acct-uuid-2")
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws OpCliNotFoundError when op binary does not exist", async () => {
        const cache = new ResolverCache(new SecretCache())
        await assert.rejects(
            new EmailAccountResolver("user@example.com", new OpRunner("/no/such/op"), cache).resolve(),
            (err) => err instanceof OpCliNotFoundError,
        )
    })

    test("throws OpCliError on non-zero exit from op account list", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "fail" })

        try {
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new EmailAccountResolver("user@example.com", new OpRunner(fake.path), cache).resolve(),
                (err) => err instanceof OpCliError,
            )
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
            const promise = new EmailAccountResolver(
                "user@example.com",
                new OpRunner(fake.path),
                cache,
            ).resolve(controller.signal)
            setTimeout(() => controller.abort(), 50)
            await assert.rejects(promise)
        }
        finally {
            await fake.cleanup()
        }
    })
})

suite("resolveAccountForGitConfig", () => {
    test("resolves email from git config then looks up account", async () => {
        if (process.platform === "win32") return

        const fakeGit = await makeFakeGit({ userEmail: "user@example.com" })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            const uuid = await new GitConfigAccountResolver(
                ".",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                "/workspace",
            ).resolve()
            assert.strictEqual(uuid, "acct-uuid-1")
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
        }
    })

    test("re-runs git on every call — the email is not cached", async () => {
        if (process.platform === "win32") return

        const gitLogFile = path.join(os.tmpdir(), `sr-git-log-${Date.now()}.txt`)
        const fakeGit = await makeFakeGit({ userEmail: "user@example.com", argLogFile: gitLogFile })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            const run = () =>
                new GitConfigAccountResolver(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner(fakeGit.path),
                    cache,
                    "/workspace",
                ).resolve()

            await run()
            await run()

            const log = await fs.readFile(gitLogFile, "utf8").catch(() => "")
            const gitCalls = log.split("\n").filter((line) => line.trim() !== "")
            assert.strictEqual(gitCalls.length, 2, "git should be spawned on every call")
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
            await fs.rm(gitLogFile, { force: true })
        }
    })

    test("runs git in the workspacePath/subdir directory", async () => {
        if (process.platform === "win32") return

        const gitLogFile = path.join(os.tmpdir(), `sr-git-log-${Date.now()}.txt`)
        const fakeGit = await makeFakeGit({ userEmail: "user@example.com", argLogFile: gitLogFile })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            await new GitConfigAccountResolver(
                "backend",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                "/workspace",
            ).resolve()

            const log = await fs.readFile(gitLogFile, "utf8").catch(() => "")
            assert.ok(
                log.includes(`-C ${path.join("/workspace", "backend")} `),
                `expected git to run in the joined subdir, got: ${log.trim()}`,
            )
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
            await fs.rm(gitLogFile, { force: true })
        }
    })

    test("throws an Error for an absolute subdir", async () => {
        const cache = new ResolverCache(new SecretCache())
        await assert.rejects(
            new GitConfigAccountResolver(
                "/absolute/path",
                new OpRunner("op"),
                new GitRunner(),
                cache,
            ).resolve(),
            (err) =>
                err instanceof Error
                && (err as Error).message.includes("SECRET_RESOLVER_ACCOUNT_GIT_CONFIG"),
        )
    })

    test("throws an Error for a subdir that escapes the workspace", async () => {
        const cache = new ResolverCache(new SecretCache())
        await assert.rejects(
            new GitConfigAccountResolver(
                "../../etc",
                new OpRunner("op"),
                new GitRunner(),
                cache,
                "/workspace",
            ).resolve(),
            (err) =>
                err instanceof Error
                && (err as Error).message.includes("below the workspace"),
        )
    })

    test("throws GitEmailNotFoundError when git config exits non-zero", async () => {
        if (process.platform === "win32") return

        const fakeGit = await makeFakeGit({ userEmail: "fail" })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new GitConfigAccountResolver(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner(fakeGit.path),
                    cache,
                    "/workspace",
                ).resolve(),
                (err) => err instanceof GitEmailNotFoundError,
            )
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
        }
    })

    test("throws GitEmailNotFoundError when git binary is not found", async () => {
        if (process.platform === "win32") return

        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new ResolverCache(new SecretCache())
            await assert.rejects(
                new GitConfigAccountResolver(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner("/no/such/git"),
                    cache,
                    "/workspace",
                ).resolve(),
                (err) => err instanceof GitEmailNotFoundError,
            )
        }
        finally {
            await fakeOp.cleanup()
        }
    })

    test("propagates AbortSignal cancellation", async () => {
        if (process.platform === "win32") return

        const fakeOp = await makeFakeOp({ listResult: "slow" })

        try {
            const cache = new ResolverCache(new SecretCache())
            const controller = new AbortController()
            const fakeGit = await makeFakeGit({ userEmail: "user@example.com" })

            try {
                const promise = new GitConfigAccountResolver(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner(fakeGit.path),
                    cache,
                    "/workspace",
                ).resolve(controller.signal)
                setTimeout(() => controller.abort(), 50)
                await assert.rejects(promise)
            }
            finally {
                await fakeGit.cleanup()
            }
        }
        finally {
            await fakeOp.cleanup()
        }
    })
})
