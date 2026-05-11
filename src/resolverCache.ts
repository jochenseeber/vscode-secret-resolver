import type { SecretCache } from "./secretCache"

const RESOLVED_REF_PREFIX = "resolved-ref:"
const TOKEN_PREFIX = "token:"
const ACCOUNT_PREFIX = "account:"

export function getCachedResolvedRef(
    cache: SecretCache,
    opRef: string,
): string | undefined {
    return cache.get(RESOLVED_REF_PREFIX + opRef)
}

export function setCachedResolvedRef(
    cache: SecretCache,
    opRef: string,
    value: string,
): void {
    cache.set(RESOLVED_REF_PREFIX + opRef, value)
}

export function getCachedToken(
    cache: SecretCache,
    tag: string,
): string | undefined {
    return cache.get(TOKEN_PREFIX + tag)
}

export function setCachedToken(
    cache: SecretCache,
    tag: string,
    token: string,
): void {
    cache.set(TOKEN_PREFIX + tag, token)
}

export function getCachedAccountId(
    cache: SecretCache,
    email: string,
): string | undefined {
    return cache.get(accountKey(email))
}

export function setCachedAccountId(
    cache: SecretCache,
    email: string,
    accountId: string,
): void {
    cache.set(accountKey(email), accountId)
}

function accountKey(email: string): string {
    return ACCOUNT_PREFIX + email.toLowerCase()
}
