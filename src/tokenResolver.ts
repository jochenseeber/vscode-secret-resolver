import type { Logger } from "./logger"
import { OpRunner } from "./opRunner"
import { ResolverCache } from "./resolverCache"

export class TokenNotFoundError extends Error {
    constructor(tag: string) {
        super(`No "API Credential" vault item found with tag "${tag}".`)
        this.name = "TokenNotFoundError"
    }
}

export class TokenCredentialMissingError extends Error {
    constructor(itemId: string) {
        super(
            `Vault item "${itemId}" has no "credential" field. Add a "credential" field containing the service account token.`,
        )
        this.name = "TokenCredentialMissingError"
    }
}

export abstract class TokenResolver {
    abstract resolve(accountId: string | undefined, signal?: AbortSignal): Promise<string | null>
}

/**
 * Creates token resolvers for the launch-planning code. Implemented by the
 * `vscode`-aware config provider so `LaunchConfigResolver` stays constructible
 * in unit tests without the extension host.
 */
export interface TokenResolverFactory {
    createForTag(tag: string): TokenResolver
}

export class NullTokenResolver extends TokenResolver {
    async resolve(_accountId: string | undefined, _signal?: AbortSignal): Promise<null> {
        return null
    }
}

/**
 * Resolves the service account token for `tag` by querying the 1Password CLI,
 * caching the result in the token namespace of `ResolverCache` so subsequent
 * launches with the same tag skip the CLI calls. Throws on any failure. When
 * several items carry the tag, the first one is used and a warning is logged.
 */
export class TagTokenResolver extends TokenResolver {
    constructor(
        private readonly tag: string,
        private readonly runner: OpRunner,
        private readonly cache: ResolverCache,
        private readonly logger: Logger,
    ) {
        super()
    }

    async resolve(accountId: string | undefined, signal?: AbortSignal): Promise<string> {
        const cached = this.cache.getToken(this.tag)

        if (cached !== null) {
            return cached
        }

        const items = await this.runner.listItems(this.tag, { signal, account: accountId })

        if (items.length === 0) {
            throw new TokenNotFoundError(this.tag)
        }

        if (items.length > 1) {
            this.logger.warn(
                `${items.length} "API Credential" items carry tag "${this.tag}"; using the first (item "${
                    items[0].id
                }").`,
            )
        }

        const { id, vaultId } = items[0]
        const credential = await this.runner.getItemCredential(id, vaultId, { signal, account: accountId })

        if (credential === null) {
            throw new TokenCredentialMissingError(id)
        }

        this.cache.setToken(this.tag, credential)
        return credential
    }
}
