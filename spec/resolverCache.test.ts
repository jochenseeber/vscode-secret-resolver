import * as assert from "node:assert"

import {
    getCachedAccountId,
    getCachedResolvedRef,
    getCachedToken,
    setCachedAccountId,
    setCachedResolvedRef,
    setCachedToken,
} from "../src/resolverCache"

import { SecretCache } from "../src/secretCache"

suite("resolverCache", () => {
    test("keeps resolved refs, tokens, and accounts in separate namespaces", () => {
        const cache = new SecretCache()
        const sharedKey = "same-key"

        setCachedResolvedRef(cache, sharedKey, "resolved-ref")
        setCachedToken(cache, sharedKey, "token")
        setCachedAccountId(cache, sharedKey, "account-id")

        assert.strictEqual(getCachedResolvedRef(cache, sharedKey), "resolved-ref")
        assert.strictEqual(getCachedToken(cache, sharedKey), "token")
        assert.strictEqual(getCachedAccountId(cache, sharedKey), "account-id")
    })

    test("normalizes account email keys case-insensitively", () => {
        const cache = new SecretCache()
        setCachedAccountId(cache, "User@Example.com", "account-id")
        assert.strictEqual(getCachedAccountId(cache, "user@example.COM"), "account-id")
    })
})
