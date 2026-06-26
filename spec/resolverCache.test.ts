import * as assert from "node:assert"

import { ResolverCache } from "../src/resolverCache"
import { SecretCache } from "../src/secretCache"

const DEFAULT_SCOPE = { accountId: null, tokenTag: null }

suite("ResolverCache", () => {
    test("keeps resolved refs, tokens, and accounts in separate namespaces", () => {
        const cache = new ResolverCache(new SecretCache())
        const sharedKey = "same-key"

        cache.setResolvedRef(sharedKey, DEFAULT_SCOPE, "resolved-ref")
        cache.setToken(sharedKey, "token")
        cache.setAccountId(sharedKey, "account-id")

        assert.strictEqual(cache.getResolvedRef(sharedKey, DEFAULT_SCOPE), "resolved-ref")
        assert.strictEqual(cache.getToken(sharedKey), "token")
        assert.strictEqual(cache.getAccountId(sharedKey), "account-id")
    })

    test("scopes resolved refs by account and token tag", () => {
        const cache = new ResolverCache(new SecretCache())
        const personalScope = { accountId: "account-a", tokenTag: null }
        const workScope = { accountId: "account-b", tokenTag: null }
        const taggedScope = { accountId: "account-a", tokenTag: "ci-tag" }

        cache.setResolvedRef("op://v/i/f", personalScope, "personal-value")

        assert.strictEqual(cache.getResolvedRef("op://v/i/f", personalScope), "personal-value")
        assert.strictEqual(cache.getResolvedRef("op://v/i/f", workScope), null)
        assert.strictEqual(cache.getResolvedRef("op://v/i/f", taggedScope), null)
    })

    test("does not confuse scope parts across delimiter-like values", () => {
        const cache = new ResolverCache(new SecretCache())
        const compositeAccountScope = { accountId: "a:b", tokenTag: "c" }
        const compositeTagScope = { accountId: "a", tokenTag: "b:c" }

        cache.setResolvedRef("op://v/i/f", compositeAccountScope, "composite-account-value")

        assert.strictEqual(cache.getResolvedRef("op://v/i/f", compositeTagScope), null)
    })

    test("normalizes account email keys case-insensitively", () => {
        const cache = new ResolverCache(new SecretCache())
        cache.setAccountId("User@Example.com", "account-id")
        assert.strictEqual(cache.getAccountId("user@example.COM"), "account-id")
    })

    test("returns null for a miss", () => {
        const cache = new ResolverCache(new SecretCache())
        assert.strictEqual(cache.getResolvedRef("absent", DEFAULT_SCOPE), null)
        assert.strictEqual(cache.getToken("absent"), null)
        assert.strictEqual(cache.getAccountId("absent@example.com"), null)
    })
})
