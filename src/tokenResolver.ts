import { getCachedToken as readCachedToken, setCachedToken } from "./resolverCache"

import { OpRunner } from "./opRunner"
import type { SecretCache } from "./secretCache"

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

export { getCachedToken } from "./resolverCache"

/**
 * Resolves the service account token for `tag` by querying the 1Password CLI.
 * Caches the result in the token namespace of `cache` so subsequent launches
 * with the same tag skip the CLI calls. Throws on any failure.
 */
export async function resolveTokenForTag(
    tag: string,
    runner: OpRunner,
    cache: SecretCache,
    signal?: AbortSignal,
    account?: string,
): Promise<string> {
    const cached = readCachedToken(cache, tag)

    if (cached !== undefined) {
        return cached
    }

    const items = await runner.listItems(tag, { signal, account })

    if (items.length === 0) {
        throw new TokenNotFoundError(tag)
    }

    const { id, vaultId } = items[0]
    const credential = await runner.getItemCredential(id, vaultId, { signal, account })

    if (credential === "") {
        throw new TokenCredentialMissingError(id)
    }

    setCachedToken(cache, tag, credential)
    return credential
}
