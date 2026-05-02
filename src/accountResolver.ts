import { execFile } from "node:child_process"
import * as path from "node:path"
import { promisify } from "node:util"

import { OpCliNotFoundError, OpInjectError } from "./opInject"
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
 */
export interface GitEmailStore {
    get(dir: string): string | undefined
    set(dir: string, email: string): void
    clear(): void
}

const CACHE_KEY_PREFIX = "__account__:"

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
    let stdout: string

    try {
        ;({ stdout } = await execFileAsync(
            opPath,
            ["account", "list", "--format", "json"],
            { signal, encoding: "utf8" },
        ))
    }
    catch (err) {
        throw normalizeExecError(err, opPath)
    }

    let accounts: Array<{ email?: string; account_uuid?: string }>

    try {
        accounts = JSON.parse(stdout) as Array<{
            email?: string
            account_uuid?: string
        }>
    }
    catch {
        throw new OpInjectError("op account list returned non-JSON output", stdout, null)
    }

    const lower = email.toLowerCase()
    const match = accounts.find(
        (a) => typeof a.email === "string" && a.email.toLowerCase() === lower,
    )

    if (match === undefined || typeof match.account_uuid !== "string") {
        throw new AccountNotFoundError(email)
    }

    return match.account_uuid
}

function normalizeExecError(err: unknown, opPath: string): Error {
    if (typeof err !== "object" || err === null) {
        return new OpInjectError(String(err), "", null)
    }

    const e = err as NodeJS.ErrnoException & {
        stderr?: string | Buffer
        code?: string | number
    }

    if (e.code === "ENOENT") {
        return new OpCliNotFoundError(opPath)
    }

    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
        return e as Error
    }

    const stderr = e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : typeof e.stderr === "string"
        ? e.stderr
        : ""
    const trimmed = stderr.trim()
    const exitCode = typeof e.code === "number" ? e.code : null
    const message = trimmed.length > 0
        ? `op failed: ${trimmed}`
        : `op failed: ${e.message}`
    return new OpInjectError(message, stderr, exitCode)
}

/**
 * Resolves a 1Password `account_uuid` from a plain email address.
 * Caches the result under `__account__:<lowercase-email>` in `cache`.
 */
export async function resolveAccountForEmail(
    email: string,
    opPath: string,
    cache: SecretCache,
    signal?: AbortSignal,
): Promise<string> {
    const cacheKey = CACHE_KEY_PREFIX + email.toLowerCase()
    const cachedUuid = cache.get(cacheKey)

    if (cachedUuid !== undefined) {
        return cachedUuid
    }

    const uuid = await findAccountByEmail(email, opPath, signal)
    cache.set(cacheKey, uuid)
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

    const cacheKey = CACHE_KEY_PREFIX + email.toLowerCase()
    const cachedUuid = cache.get(cacheKey)

    if (cachedUuid !== undefined) {
        return cachedUuid
    }

    const uuid = await findAccountByEmail(email, opPath, signal)
    cache.set(cacheKey, uuid)
    return uuid
}
