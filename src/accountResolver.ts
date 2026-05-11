import * as path from "node:path"

import { getCachedAccountId, setCachedAccountId } from "./resolverCache"

import { GitRunner } from "./gitRunner"
import { type OpAccount, OpRunner } from "./opRunner"
import type { SecretCache } from "./secretCache"

export { GitEmailNotFoundError } from "./gitRunner"

export class AccountNotFoundError extends Error {
    constructor(email: string) {
        super(`No 1Password account found matching email "${email}".`)
        this.name = "AccountNotFoundError"
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

async function findAccountByEmail(
    email: string,
    runner: OpRunner,
    signal: AbortSignal | undefined,
): Promise<string> {
    const accounts = await runner.listAccounts({ signal })
    const lower = email.toLowerCase()
    const match = accounts.find(
        (a): a is OpAccount & { accountUuid: string } =>
            a.email.toLowerCase() === lower && a.accountUuid !== "",
    )

    if (match === undefined) {
        throw new AccountNotFoundError(email)
    }

    const uuid = match.accountUuid
    return uuid
}

/**
 * Resolves a 1Password `account_uuid` from a plain email address.
 * Caches the result in the account namespace of `cache`.
 */
export async function resolveAccountForEmail(
    email: string,
    runner: OpRunner,
    cache: SecretCache,
    signal?: AbortSignal,
): Promise<string> {
    const cachedUuid = getCachedAccountId(cache, email)

    if (cachedUuid !== undefined) {
        return cachedUuid
    }

    const uuid = await findAccountByEmail(email, runner, signal)
    setCachedAccountId(cache, email, uuid)
    return uuid
}

/**
 * Resolves a 1Password `account_uuid` by reading `user.email` from git config
 * at `workspacePath/subdir`, then looking up the matching account.
 *
 * Layer 1 cache: `gitEmailStore` maps `.git`-dir → email (persisted in
 * `workspaceState`; avoids calling git on every launch).
 * Layer 2 cache: `cache` maps email → account_uuid (in-memory `SecretCache`).
 */
export async function resolveAccountForGitConfig(
    subdir: string,
    runner: OpRunner,
    gitRunner: GitRunner,
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
        email = await gitRunner.getEmail(workDir, signal)
        gitEmailStore?.set(gitDir, email)
    }

    return resolveAccountForEmail(email, runner, cache, signal)
}
