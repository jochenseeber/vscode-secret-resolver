import * as assert from "node:assert"

import {
    DEFAULT_STEP_DELAY_SECONDS,
    findOpRefs,
    hasOpRef,
    isOpRef,
    mergeEnv,
    parseSecretResolverMode,
    parseSignalOnStop,
    replaceOpRefs,
    stripInternalEnvVars,
} from "../src/envHelpers"

function captureWarnings<T>(body: () => T): { warnings: unknown[][]; result: T } {
    const original = console.warn
    const warnings: unknown[][] = []

    console.warn = (...args: unknown[]) => {
        warnings.push(args)
    }

    try {
        const result = body()
        return { warnings, result }
    }
    finally {
        console.warn = original
    }
}

suite("isOpRef", () => {
    test("recognizes an op:// value", () => {
        assert.strictEqual(isOpRef("op://Vault/item/field"), true)
    })

    test("rejects values not starting with op://", () => {
        assert.strictEqual(isOpRef("https://example.com"), false)
        assert.strictEqual(isOpRef(" op://leading-space"), false)
        assert.strictEqual(isOpRef(""), false)
    })

    test("rejects null and undefined", () => {
        assert.strictEqual(isOpRef(null), false)
        assert.strictEqual(isOpRef(undefined), false)
    })
})

suite("findOpRefs", () => {
    test("returns unique op:// values in iteration order", () => {
        const env = {
            A: "op://a/1/x",
            B: "plain",
            C: "op://b/2/y",
            D: "op://a/1/x",
        }
        assert.deepStrictEqual(findOpRefs(env), ["op://a/1/x", "op://b/2/y"])
    })

    test("returns empty array when none present", () => {
        assert.deepStrictEqual(findOpRefs({ A: "x", B: "y" }), [])
    })

    test("ignores non-string values", () => {
        const env = { A: null, B: undefined, C: "op://x/y/z" }
        assert.deepStrictEqual(findOpRefs(env), ["op://x/y/z"])
    })
})

suite("hasOpRef", () => {
    test("true when any value is an op:// ref", () => {
        assert.strictEqual(hasOpRef({ A: "x", B: "op://x/y/z" }), true)
    })

    test("false for empty maps and ref-free maps", () => {
        assert.strictEqual(hasOpRef({}), false)
        assert.strictEqual(hasOpRef({ A: "x", B: "y" }), false)
    })
})

suite("replaceOpRefs", () => {
    test("replaces refs and leaves other values intact", () => {
        const resolved = new Map([["op://x/y/z", "secret"]])
        const result = replaceOpRefs(
            { A: "op://x/y/z", B: "plain" },
            resolved,
        )
        assert.deepStrictEqual(result, { A: "secret", B: "plain" })
    })

    test("leaves a ref intact if no resolution provided", () => {
        const resolved = new Map<string, string>()
        const result = replaceOpRefs({ A: "op://x/y/z" }, resolved)
        assert.deepStrictEqual(result, { A: "op://x/y/z" })
    })

    test("does not mutate the input env", () => {
        const env = { A: "op://x/y/z" }
        const snapshot = { ...env }
        replaceOpRefs(env, new Map([["op://x/y/z", "secret"]]))
        assert.deepStrictEqual(env, snapshot)
    })

    test("preserves null and undefined values", () => {
        const result = replaceOpRefs(
            { A: null, B: undefined, C: "op://x/y/z" },
            new Map([["op://x/y/z", "secret"]]),
        )
        assert.deepStrictEqual(result, {
            A: null,
            B: undefined,
            C: "secret",
        })
    })
})

suite("stripInternalEnvVars", () => {
    test("removes SECRET_RESOLVER_-prefixed keys", () => {
        const env = {
            SECRET_RESOLVER_MODE: "op",
            SECRET_RESOLVER_DEBUG: "true",
            DB_URL: "x",
        }
        assert.deepStrictEqual(stripInternalEnvVars(env), { DB_URL: "x" })
    })

    test("does not strip lowercase or partial matches", () => {
        const env = {
            secret_resolver_mode: "op",
            MY_SECRET_RESOLVER_FOO: "1",
        }
        assert.deepStrictEqual(stripInternalEnvVars(env), env)
    })

    test("does not mutate the input env", () => {
        const env = { SECRET_RESOLVER_X: "1", KEEP: "y" }
        const snapshot = { ...env }
        stripInternalEnvVars(env)
        assert.deepStrictEqual(env, snapshot)
    })

    test("strips SECRET_RESOLVER_TOKEN_TAG", () => {
        const env = { SECRET_RESOLVER_TOKEN_TAG: "my-tag", KEEP: "y" }
        assert.deepStrictEqual(stripInternalEnvVars(env), { KEEP: "y" })
    })

    test("strips SECRET_RESOLVER_ACCOUNT_ID", () => {
        const env = { SECRET_RESOLVER_ACCOUNT_ID: "SOME_ACCOUNT_ID", KEEP: "y" }
        assert.deepStrictEqual(stripInternalEnvVars(env), { KEEP: "y" })
    })

    test("strips SECRET_RESOLVER_ACCOUNT_EMAIL", () => {
        const env = { SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com", KEEP: "y" }
        assert.deepStrictEqual(stripInternalEnvVars(env), { KEEP: "y" })
    })

    test("strips SECRET_RESOLVER_ACCOUNT_GIT_CONFIG", () => {
        const env = { SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: ".", KEEP: "y" }
        assert.deepStrictEqual(stripInternalEnvVars(env), { KEEP: "y" })
    })
})

suite("parseSecretResolverMode", () => {
    test("returns 'cache' for the literal 'cache'", () => {
        assert.strictEqual(parseSecretResolverMode("cache"), "cache")
    })

    test("'cache' is case-insensitive and trims surrounding whitespace", () => {
        for (const v of ["CACHE", " Cache ", "  cache\t"]) {
            assert.strictEqual(
                parseSecretResolverMode(v),
                "cache",
                `expected "${v}" to parse as "cache"`,
            )
        }
    })

    test("returns 'op' for the literal 'op'", () => {
        assert.strictEqual(parseSecretResolverMode("op"), "op")
    })

    test("'op' is case-insensitive and trims surrounding whitespace", () => {
        for (const v of ["OP", " Op ", "  op\t"]) {
            assert.strictEqual(
                parseSecretResolverMode(v),
                "op",
                `expected "${v}" to parse as "op"`,
            )
        }
    })

    test("missing / empty / unknown values all default to 'cache'", () => {
        for (const v of [undefined, null, ""] as const) {
            assert.strictEqual(parseSecretResolverMode(v), "cache")
        }
    })

    test("unknown non-empty values warn and default to 'cache'", () => {
        const original = console.warn
        const warnings: unknown[][] = []

        console.warn = (...args: unknown[]) => {
            warnings.push(args)
        }

        try {
            assert.strictEqual(parseSecretResolverMode("foo"), "cache")
            assert.strictEqual(parseSecretResolverMode("1"), "cache")
            assert.strictEqual(parseSecretResolverMode("true"), "cache")
        }
        finally {
            console.warn = original
        }

        assert.strictEqual(warnings.length, 3)
    })

    test("uses injected warning reporter", () => {
        const warnings: string[] = []
        assert.strictEqual(parseSecretResolverMode("wat", (m) => warnings.push(m)), "cache")
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /SECRET_RESOLVER_MODE/)
    })
})

suite("mergeEnv", () => {
    test("inline values win over file values", () => {
        assert.deepStrictEqual(
            mergeEnv({ A: "from-file", B: "file-only" }, { A: "from-inline" }),
            { A: "from-inline", B: "file-only" },
        )
    })

    test("file map alone is returned when inline is undefined", () => {
        assert.deepStrictEqual(
            mergeEnv({ A: "x" }, undefined),
            { A: "x" },
        )
    })

    test("does not mutate the inputs", () => {
        const fileMap = { A: "f" }
        const inlineMap = { B: "i" }
        const fileSnap = { ...fileMap }
        const inlineSnap = { ...inlineMap }
        mergeEnv(fileMap, inlineMap)
        assert.deepStrictEqual(fileMap, fileSnap)
        assert.deepStrictEqual(inlineMap, inlineSnap)
    })
})

suite("parseSignalOnStop", () => {
    test("single signal returns one step with delaySec 0", () => {
        assert.deepStrictEqual(parseSignalOnStop("TERM"), [
            { delaySec: 0, signal: "TERM" },
        ])
    })

    test("two signals without explicit delay use 0 for first, DEFAULT_STEP_DELAY_SECONDS for second", () => {
        assert.deepStrictEqual(parseSignalOnStop("TERM+KILL"), [
            { delaySec: 0, signal: "TERM" },
            { delaySec: DEFAULT_STEP_DELAY_SECONDS, signal: "KILL" },
        ])
    })

    test("explicit delay overrides the default for a subsequent step", () => {
        assert.deepStrictEqual(parseSignalOnStop("TERM+5:KILL"), [
            { delaySec: 0, signal: "TERM" },
            { delaySec: 5, signal: "KILL" },
        ])
    })

    test("leading delay applies to the first step", () => {
        assert.deepStrictEqual(parseSignalOnStop("10:INT"), [
            { delaySec: 10, signal: "INT" },
        ])
    })

    test("all four signal names are accepted", () => {
        for (const sig of ["TERM", "KILL", "INT", "HUP"] as const) {
            const result = parseSignalOnStop(sig)
            assert.deepStrictEqual(result, [{ delaySec: 0, signal: sig }])
        }
    })

    test("is case-insensitive", () => {
        assert.deepStrictEqual(parseSignalOnStop("term+kill"), [
            { delaySec: 0, signal: "TERM" },
            { delaySec: DEFAULT_STEP_DELAY_SECONDS, signal: "KILL" },
        ])
        assert.deepStrictEqual(parseSignalOnStop("Int"), [
            { delaySec: 0, signal: "INT" },
        ])
    })

    test("three-step sequence", () => {
        assert.deepStrictEqual(parseSignalOnStop("INT+10:TERM+30:KILL"), [
            { delaySec: 0, signal: "INT" },
            { delaySec: 10, signal: "TERM" },
            { delaySec: 30, signal: "KILL" },
        ])
    })

    test("missing or empty values return null", () => {
        assert.strictEqual(parseSignalOnStop(undefined), null)
        assert.strictEqual(parseSignalOnStop(null), null)
        assert.strictEqual(parseSignalOnStop(""), null)
        assert.strictEqual(parseSignalOnStop("   "), null)
    })

    test("'off' (case-insensitive) returns null", () => {
        assert.strictEqual(parseSignalOnStop("off"), null)
        assert.strictEqual(parseSignalOnStop("OFF"), null)
        assert.strictEqual(parseSignalOnStop(" Off "), null)
    })

    test("unknown signal name warns and returns null", () => {
        const { warnings, result } = captureWarnings(() => [
            parseSignalOnStop("SIGTERM"),
            parseSignalOnStop("USR1"),
        ])
        assert.deepStrictEqual(result, [null, null])
        assert.strictEqual(warnings.length, 2)
    })

    test("malformed token warns and returns null", () => {
        const { warnings, result } = captureWarnings(() => [
            parseSignalOnStop("TERM+:KILL"),
            parseSignalOnStop("TERM+1.5:KILL"),
        ])
        assert.deepStrictEqual(result, [null, null])
        assert.strictEqual(warnings.length, 2)
    })

    test("uses injected warning reporter", () => {
        const warnings: string[] = []
        assert.strictEqual(parseSignalOnStop("TERM+NOPE", (m) => warnings.push(m)), null)
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /unknown signal/)
    })
})
