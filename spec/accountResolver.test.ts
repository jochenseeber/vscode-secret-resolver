import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
    AccountNotFoundError,
    GitEmailNotFoundError,
    type GitEmailStore,
    resolveAccountForEmail,
    resolveAccountForGitConfig,
} from "../src/accountResolver"
import { GitRunner } from "../src/gitRunner"
import { OpCliNotFoundError, OpInjectError, OpRunner } from "../src/opRunner"
import { SecretCache } from "../src/secretCache"

/**
 * Fake `op` binary for `account list` calls.
 * `listResult`: JSON to emit, `"fail"` to exit non-zero, `"slow"` to sleep.
 * Handles an optional leading `--account <id>` global flag.
 */
async function makeFakeOp(opts: {
    listResult: string | "fail" | "slow"
    argLogFile?: string
}): Promise<{ path: string; dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-acct-"))
    const file = path.join(dir, "op")

    const listBlock = opts.listResult === "fail"
        ? `echo 'fake op: list error' >&2\nexit 1`
        : opts.listResult === "slow"
        ? `sleep 5\necho '[]'`
        : `printf '%s' ${JSON.stringify(opts.listResult)}`

    const logLine = opts.argLogFile
        ? `echo "$@" >> ${JSON.stringify(opts.argLogFile)}`
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
async function makeFakeGit(opts: {
    userEmail: string | "fail"
    argLogFile?: string
}): Promise<{ path: string; dir: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-git-"))
    const file = path.join(dir, "git")

    const emailBlock = opts.userEmail === "fail"
        ? `echo 'fake git: no email' >&2\nexit 1`
        : `printf '%s' ${JSON.stringify(opts.userEmail)}`

    const logLine = opts.argLogFile
        ? `echo "$@" >> ${JSON.stringify(opts.argLogFile)}`
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

class MapGitEmailStore implements GitEmailStore {
    private readonly map = new Map<string, string>()

    get(dir: string): string | undefined {
        return this.map.get(dir)
    }

    set(dir: string, email: string): void {
        this.map.set(dir, email)
    }

    clear(): void {
        this.map.clear()
    }

    get size(): number {
        return this.map.size
    }
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
            const cache = new SecretCache()
            const uuid = await resolveAccountForEmail("user@example.com", new OpRunner(fake.path), cache)
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
            const cache = new SecretCache()
            await resolveAccountForEmail("user@example.com", new OpRunner(fake.path), cache)

            const badFake = await makeFakeOp({ listResult: "fail" })

            try {
                const uuid = await resolveAccountForEmail("user@example.com", new OpRunner(badFake.path), cache)
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
            const cache = new SecretCache()
            await assert.rejects(
                resolveAccountForEmail("nobody@example.com", new OpRunner(fake.path), cache),
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
            const cache = new SecretCache()
            const uuid = await resolveAccountForEmail("OTHER@EXAMPLE.COM", new OpRunner(fake.path), cache)
            assert.strictEqual(uuid, "acct-uuid-2")
        }
        finally {
            await fake.cleanup()
        }
    })

    test("throws OpCliNotFoundError when op binary does not exist", async () => {
        const cache = new SecretCache()
        await assert.rejects(
            resolveAccountForEmail("user@example.com", new OpRunner("/no/such/op"), cache),
            (err) => err instanceof OpCliNotFoundError,
        )
    })

    test("throws OpInjectError on non-zero exit from op account list", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakeOp({ listResult: "fail" })

        try {
            const cache = new SecretCache()
            await assert.rejects(
                resolveAccountForEmail("user@example.com", new OpRunner(fake.path), cache),
                (err) => err instanceof OpInjectError,
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
            const cache = new SecretCache()
            const controller = new AbortController()
            const promise = resolveAccountForEmail(
                "user@example.com",
                new OpRunner(fake.path),
                cache,
                controller.signal,
            )
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
            const cache = new SecretCache()
            const store = new MapGitEmailStore()
            const uuid = await resolveAccountForGitConfig(
                ".",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                undefined,
                "/workspace",
                store,
            )
            assert.strictEqual(uuid, "acct-uuid-1")
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
        }
    })

    test("uses .git-appended path as gitEmailStore key", async () => {
        if (process.platform === "win32") return

        const fakeGit = await makeFakeGit({ userEmail: "user@example.com" })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new SecretCache()
            const store = new MapGitEmailStore()
            await resolveAccountForGitConfig(
                ".",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                undefined,
                "/workspace",
                store,
            )

            const expectedGitDir = path.join("/workspace", ".git")
            assert.strictEqual(store.get(expectedGitDir), "user@example.com")
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
        }
    })

    test("uses gitEmailStore on second call — no extra git spawn", async () => {
        if (process.platform === "win32") return

        const gitLogFile = path.join(os.tmpdir(), `sr-git-log-${Date.now()}.txt`)
        const fakeGit = await makeFakeGit({ userEmail: "user@example.com", argLogFile: gitLogFile })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new SecretCache()
            const store = new MapGitEmailStore()

            // Pre-populate the store with the .git dir key
            store.set(path.join("/workspace", ".git"), "user@example.com")

            const uuid = await resolveAccountForGitConfig(
                ".",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                undefined,
                "/workspace",
                store,
            )
            assert.strictEqual(uuid, "acct-uuid-1")

            const log = await fs.readFile(gitLogFile, "utf8").catch(() => "")
            assert.strictEqual(log.trim(), "", "git should not be called when store has the email")
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
            await fs.rm(gitLogFile, { force: true })
        }
    })

    test("relative subdir is joined to workspacePath with .git appended", async () => {
        if (process.platform === "win32") return

        const fakeGit = await makeFakeGit({ userEmail: "user@example.com" })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new SecretCache()
            const store = new MapGitEmailStore()
            await resolveAccountForGitConfig(
                "backend",
                new OpRunner(fakeOp.path),
                new GitRunner(fakeGit.path),
                cache,
                undefined,
                "/workspace",
                store,
            )

            assert.strictEqual(
                store.get(path.join("/workspace", "backend", ".git")),
                "user@example.com",
            )
        }
        finally {
            await fakeGit.cleanup()
            await fakeOp.cleanup()
        }
    })

    test("throws an Error for an absolute subdir", async () => {
        const cache = new SecretCache()
        await assert.rejects(
            resolveAccountForGitConfig(
                "/absolute/path",
                new OpRunner("op"),
                new GitRunner(),
                cache,
            ),
            (err) => err instanceof Error
                && (err as Error).message.includes("SECRET_RESOLVER_ACCOUNT_GIT_CONFIG"),
        )
    })

    test("throws GitEmailNotFoundError when git config exits non-zero", async () => {
        if (process.platform === "win32") return

        const fakeGit = await makeFakeGit({ userEmail: "fail" })
        const fakeOp = await makeFakeOp({ listResult: ACCOUNTS_JSON })

        try {
            const cache = new SecretCache()
            await assert.rejects(
                resolveAccountForGitConfig(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner(fakeGit.path),
                    cache,
                    undefined,
                    "/workspace",
                ),
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
            const cache = new SecretCache()
            await assert.rejects(
                resolveAccountForGitConfig(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner("/no/such/git"),
                    cache,
                    undefined,
                    "/workspace",
                ),
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
            const cache = new SecretCache()
            const controller = new AbortController()
            const fakeGit = await makeFakeGit({ userEmail: "user@example.com" })

            try {
                const promise = resolveAccountForGitConfig(
                    ".",
                    new OpRunner(fakeOp.path),
                    new GitRunner(fakeGit.path),
                    cache,
                    controller.signal,
                    "/workspace",
                )
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
