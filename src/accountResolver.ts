import * as path from "node:path"

import { getCachedAccountId, setCachedAccountId } from "./resolverCache"

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OpCli } from "./opCli"
import type { SecretCache } from "./secretCache"

const execFileAsync = promisify(execFile)

export class AccountNotFoundError extends Error {
    constructor(email: string) {
        super(`No 1Password account found matching email "${email}".`)
        this.name = "AccountNotFoundError"
    }
}

export class GitEmailNotFoundError extends Error {
    constructor(message?: string) {
        super(message ?? "Could not read user.email from git config.")
        this.name = "GitEmailNotFoundError"
    }
}

/**
 * Injected by `configProvider.ts`, backed by `workspaceState`. Caches the
 * git-directory → email mapping so `git config` is not re-run every launch.
 * Persistence is best-effort: callers should not depend on `set`/`clear`
 * completing before the current launch continues.
 */
export interface GitEmailStore {
    get(dir: string): string | undefined
    set(dir: string, email: string): void
    clear(): void
}

async function getGitEmail(
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<string> {
    let stdout: string

    try {
        ;({ stdout } = await execFileAsync(
            "git",
            ["-C", cwd, "config", "--get", "user.email"],
            { signal, encoding: "utf8" },
        ))
    }
    catch (err) {
        const e = err as NodeJS.ErrnoException & { code?: string | number }

        if (e.code === "ENOENT") {
            throw new GitEmailNotFoundError(
                "git is not installed or not on PATH.",
            )
        }

        if (e.name === "AbortError" || e.code === "ABORT_ERR") {
            throw e
        }

        throw new GitEmailNotFoundError(
            `git config --get user.email failed: ${e.message}`,
        )
    }

    const email = stdout.trim()

    if (email === "") {
        throw new GitEmailNotFoundError()
    }

    return email
}

async function findAccountByEmail(
    email: string,
    opPath: string,
    signal: AbortSignal | undefined,
): Promise<string> {
    const accounts = await new OpCli(opPath).execJson<
        Array<{
            email?: string
            account_uuid?: string
        }>
    >(["account", "list", "--format", "json"], {
        signal,
        parseErrorMessage: "op account list returned non-JSON output",
    })

    const lower = email.toLowerCase()
    const match = accounts.find(
        (a) => typeof a.email === "string" && a.email.toLowerCase() === lower,
    )

    if (match === undefined || typeof match.account_uuid !== "string") {
        throw new AccountNotFoundError(email)
    }

    const uuid = match.account_uuid
    return uuid
}

/**
 * Resolves a 1Password `account_uuid` from a plain email address.
 * Caches the result in the account namespace of `cache`.
 */
export async function resolveAccountForEmail(
    email: string,
    opPath: string,
    cache: SecretCache,
    signal?: AbortSignal,
): Promise<string> {
    const cachedUuid = getCachedAccountId(cache, email)

    if (cachedUuid !== undefined) {
        return cachedUuid
    }

    const uuid = await findAccountByEmail(email, opPath, signal)
    setCachedAccountId(cache, email, uuid)
    return uuid
}

/**
 * Resolves a 1Password `account_uuid` by reading `user.email` from git config
 * at `workspacePath/subdir/.git`, then looking up the matching account.
 *
 * Layer 1 cache: `gitEmailStore` maps `.git`-dir → email (persisted in
 * `workspaceState`; avoids calling git on every launch).
 * Layer 2 cache: `cache` maps email → account_uuid (in-memory `SecretCache`).
 */
export async function resolveAccountForGitConfig(
    subdir: string,
    opPath: string,
    cache: SecretCache,
    signal?: AbortSignal,
    workspacePath?: string,
    gitEmailStore?: GitEmailStore,
): Promise<string> {
    if (path.isAbsolute(subdir)) {
        throw new Error(
            `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG must be a relative path, got "${subdir}".`,
        )
    }

    const workDir = path.resolve(workspacePath ?? ".", subdir)
    const gitDir = path.join(workDir, ".git")

    const cachedEmail = gitEmailStore?.get(gitDir)
    let email: string

    if (cachedEmail !== undefined) {
        email = cachedEmail
    }
    else {
        email = await getGitEmail(gitDir, signal)
        gitEmailStore?.set(gitDir, email)
    }

    const cachedUuid = getCachedAccountId(cache, email)

    if (cachedUuid !== undefined) {
        return cachedUuid
    }

    const uuid = await findAccountByEmail(email, opPath, signal)
    setCachedAccountId(cache, email, uuid)
    return uuid
}
