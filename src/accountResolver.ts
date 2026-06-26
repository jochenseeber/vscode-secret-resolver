import * as path from "node:path"

import { GitRunner } from "./gitRunner"
import { OpRunner } from "./opRunner"
import { ResolverCache } from "./resolverCache"

export { GitEmailNotFoundError } from "./gitRunner"

export class AccountNotFoundError extends Error {
    constructor(email: string) {
        super(`No 1Password account found matching email "${email}".`)
        this.name = "AccountNotFoundError"
    }
}

export abstract class AccountResolver {
    abstract resolve(signal?: AbortSignal): Promise<string | null>
}

/**
 * Creates account resolvers for the launch-planning code. Implemented by the
 * `vscode`-aware config provider so `LaunchConfigResolver` stays constructible
 * in unit tests without the extension host.
 */
export interface AccountResolverFactory {
    createForEmail(email: string): AccountResolver
    createForGitConfig(
        subdirectory: string,
        workspacePath: string | undefined,
    ): AccountResolver
}

export class NullAccountResolver extends AccountResolver {
    async resolve(_signal?: AbortSignal): Promise<null> {
        return null
    }
}

export class LiteralAccountResolver extends AccountResolver {
    constructor(private readonly accountId: string) {
        super()
    }

    async resolve(_signal?: AbortSignal): Promise<string> {
        return this.accountId
    }
}

/**
 * Resolves a 1Password `account_uuid` from a plain email address, caching the
 * result in the account namespace of `ResolverCache`.
 */
export class EmailAccountResolver extends AccountResolver {
    constructor(
        private readonly email: string,
        private readonly runner: OpRunner,
        private readonly cache: ResolverCache,
    ) {
        super()
    }

    async resolve(signal?: AbortSignal): Promise<string> {
        const cachedUuid = this.cache.getAccountId(this.email)

        if (cachedUuid !== null) {
            return cachedUuid
        }

        const uuid = await this.findAccountByEmail(signal)
        this.cache.setAccountId(this.email, uuid)
        return uuid
    }

    private async findAccountByEmail(signal: AbortSignal | undefined): Promise<string> {
        const accounts = await this.runner.listAccounts({ signal })
        const lowerEmail = this.email.toLowerCase()
        const match = accounts.find(
            (account) => account.email.toLowerCase() === lowerEmail,
        )

        if (match === undefined) {
            throw new AccountNotFoundError(this.email)
        }

        const uuid = match.accountUuid
        return uuid
    }
}

/**
 * Resolves a 1Password `account_uuid` by reading `user.email` from git config
 * at `workspacePath/subdirectory`, then delegating to `EmailAccountResolver`.
 * `git config` runs on every launch — the email is not cached; the resolved
 * email → account_uuid mapping is cached in `ResolverCache`. `subdirectory`
 * must be relative (`.` = workspace root) and must resolve to a path below
 * the workspace (no `..` traversal outside it).
 */
export class GitConfigAccountResolver extends AccountResolver {
    constructor(
        private readonly subdirectory: string,
        private readonly runner: OpRunner,
        private readonly gitRunner: GitRunner,
        private readonly cache: ResolverCache,
        private readonly workspacePath?: string,
    ) {
        super()
    }

    async resolve(signal?: AbortSignal): Promise<string> {
        if (path.isAbsolute(this.subdirectory)) {
            throw new Error(
                `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG must be a relative path, got "${this.subdirectory}".`,
            )
        }

        const workspaceRoot = path.resolve(this.workspacePath ?? ".")
        const workingDirectory = path.resolve(workspaceRoot, this.subdirectory)
        const relative = path.relative(workspaceRoot, workingDirectory)

        if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
            throw new Error(
                `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG must resolve to a path below the workspace, got "${this.subdirectory}".`,
            )
        }

        const email = await this.gitRunner.getEmail(workingDirectory, signal)
        const accountId = await new EmailAccountResolver(email, this.runner, this.cache).resolve(signal)
        return accountId
    }
}
