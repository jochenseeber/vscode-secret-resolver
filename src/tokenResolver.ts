import { getCachedToken as readCachedToken, setCachedToken } from "./resolverCache"

import { OpCli } from "./opCli"
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
    opPath: string,
    cache: SecretCache,
    signal?: AbortSignal,
    account?: string,
): Promise<string> {
    const cached = readCachedToken(cache, tag)

    if (cached !== undefined) {
        return cached
    }

    const opCli = new OpCli(opPath)
    const itemId = await findItemIdForTag(tag, opCli, signal, account)
    const token = await getCredentialField(itemId.id, itemId.vaultId, opCli, signal, account)

    setCachedToken(cache, tag, token)
    return token
}

async function findItemIdForTag(
    tag: string,
    opCli: OpCli,
    signal: AbortSignal | undefined,
    account: string | undefined,
): Promise<{ id: string; vaultId: string }> {
    const items = await opCli.execJson<Array<{ id?: string; vault?: { id?: string } }>>(
        [
            "item",
            "list",
            "--tags",
            tag,
            "--categories",
            "API Credential",
            "--format",
            "json",
        ],
        {
            signal,
            account,
            withoutServiceAccountToken: true,
            parseErrorMessage: "op item list returned non-JSON output",
        },
    )

    if (!Array.isArray(items) || items.length === 0) {
        throw new TokenNotFoundError(tag)
    }

    const item = items[0]
    const id = item.id
    const vaultId = item.vault?.id

    if (typeof id !== "string" || typeof vaultId !== "string") {
        throw new TokenNotFoundError(tag)
    }

    const itemRef = { id, vaultId }
    return itemRef
}

async function getCredentialField(
    itemId: string,
    vaultId: string,
    opCli: OpCli,
    signal: AbortSignal | undefined,
    account: string | undefined,
): Promise<string> {
    const parsed = await opCli.execJson<unknown>(
        [
            "item",
            "get",
            itemId,
            "--vault",
            vaultId,
            "--fields",
            "label=credential",
            "--format",
            "json",
        ],
        {
            signal,
            account,
            withoutServiceAccountToken: true,
            parseErrorMessage: "op item get returned non-JSON output",
        },
    )
    // op item get --fields returns an array when --format json is used.
    const fields = Array.isArray(parsed) ? (parsed as Array<{ value?: unknown }>) : [parsed as { value?: unknown }]

    const value = fields[0]?.value

    if (typeof value !== "string" || value === "") {
        throw new TokenCredentialMissingError(itemId)
    }

    return value
}
