import type { SecretCache } from "./secretCache"

const RESOLVED_REF_PREFIX = "resolved-ref:"
const TOKEN_PREFIX = "token:"
const ACCOUNT_PREFIX = "account:"

/**
 * The 1Password resolution context a resolved ref is only valid in: the
 * account it was resolved against and the service-account token tag that was
 * in effect. A ref cached under one scope is never served under another, so
 * multi-account launches that share an `op://` path cannot poison each other.
 */
export interface RefResolutionScope {
    readonly accountId: string | null
    readonly tokenTag: string | null
}

/**
 * Domain cache namespaces layered over `SecretCache`: resolved `op://` refs,
 * service-account tokens, and account IDs. Owns the synthetic key naming so
 * callers never construct cache keys directly. A miss returns `null`
 * ("currently unavailable") rather than `undefined`.
 */
export class ResolverCache {
    constructor(private readonly cache: SecretCache) {}

    getResolvedRef(opRef: string, scope: RefResolutionScope): string | null {
        const value = this.cache.get(this.resolvedRefKey(opRef, scope)) ?? null
        return value
    }

    setResolvedRef(opRef: string, scope: RefResolutionScope, value: string): void {
        this.cache.set(this.resolvedRefKey(opRef, scope), value)
    }

    private resolvedRefKey(opRef: string, scope: RefResolutionScope): string {
        // JSON keeps the scope parts unambiguously delimited even when they
        // contain separator-like characters.
        const key = `${RESOLVED_REF_PREFIX}${JSON.stringify([scope.accountId, scope.tokenTag, opRef])}`
        return key
    }

    getToken(tag: string): string | null {
        const token = this.cache.get(`${TOKEN_PREFIX}${tag}`) ?? null
        return token
    }

    setToken(tag: string, token: string): void {
        this.cache.set(`${TOKEN_PREFIX}${tag}`, token)
    }

    getAccountId(email: string): string | null {
        const accountId = this.cache.get(this.accountKey(email)) ?? null
        return accountId
    }

    setAccountId(email: string, accountId: string): void {
        this.cache.set(this.accountKey(email), accountId)
    }

    private accountKey(email: string): string {
        const key = `${ACCOUNT_PREFIX}${email.toLowerCase()}`
        return key
    }
}
