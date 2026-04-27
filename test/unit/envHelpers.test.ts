import * as assert from "node:assert";

import {
    findOpRefs,
    hasOpRef,
    isOpRef,
    mergeEnv,
    parseSecretResolverMode,
    replaceOpRefs,
    stripInternalEnvVars,
} from "../../src/envHelpers";

suite("isOpRef", () => {
    test("recognizes an op:// value", () => {
        assert.strictEqual(isOpRef("op://Vault/item/field"), true);
    });

    test("rejects values not starting with op://", () => {
        assert.strictEqual(isOpRef("https://example.com"), false);
        assert.strictEqual(isOpRef(" op://leading-space"), false);
        assert.strictEqual(isOpRef(""), false);
    });

    test("rejects null and undefined", () => {
        assert.strictEqual(isOpRef(null), false);
        assert.strictEqual(isOpRef(undefined), false);
    });
});

suite("findOpRefs", () => {
    test("returns unique op:// values in iteration order", () => {
        const env = {
            A: "op://a/1/x",
            B: "plain",
            C: "op://b/2/y",
            D: "op://a/1/x",
        };
        assert.deepStrictEqual(findOpRefs(env), ["op://a/1/x", "op://b/2/y"]);
    });

    test("returns empty array when none present", () => {
        assert.deepStrictEqual(findOpRefs({ A: "x", B: "y" }), []);
    });

    test("ignores non-string values", () => {
        const env = { A: null, B: undefined, C: "op://x/y/z" };
        assert.deepStrictEqual(findOpRefs(env), ["op://x/y/z"]);
    });
});

suite("hasOpRef", () => {
    test("true when any value is an op:// ref", () => {
        assert.strictEqual(hasOpRef({ A: "x", B: "op://x/y/z" }), true);
    });

    test("false for empty maps and ref-free maps", () => {
        assert.strictEqual(hasOpRef({}), false);
        assert.strictEqual(hasOpRef({ A: "x", B: "y" }), false);
    });
});

suite("replaceOpRefs", () => {
    test("replaces refs and leaves other values intact", () => {
        const resolved = new Map([["op://x/y/z", "secret"]]);
        const result = replaceOpRefs(
            { A: "op://x/y/z", B: "plain" },
            resolved,
        );
        assert.deepStrictEqual(result, { A: "secret", B: "plain" });
    });

    test("leaves a ref intact if no resolution provided", () => {
        const resolved = new Map<string, string>();
        const result = replaceOpRefs({ A: "op://x/y/z" }, resolved);
        assert.deepStrictEqual(result, { A: "op://x/y/z" });
    });

    test("does not mutate the input env", () => {
        const env = { A: "op://x/y/z" };
        const snapshot = { ...env };
        replaceOpRefs(env, new Map([["op://x/y/z", "secret"]]));
        assert.deepStrictEqual(env, snapshot);
    });

    test("preserves null and undefined values", () => {
        const result = replaceOpRefs(
            { A: null, B: undefined, C: "op://x/y/z" },
            new Map([["op://x/y/z", "secret"]]),
        );
        assert.deepStrictEqual(result, {
            A: null,
            B: undefined,
            C: "secret",
        });
    });
});

suite("stripInternalEnvVars", () => {
    test("removes SECRET_RESOLVER_-prefixed keys", () => {
        const env = {
            SECRET_RESOLVER_MODE: "op",
            SECRET_RESOLVER_DEBUG: "true",
            DB_URL: "x",
        };
        assert.deepStrictEqual(stripInternalEnvVars(env), { DB_URL: "x" });
    });

    test("does not strip lowercase or partial matches", () => {
        const env = {
            secret_resolver_mode: "op",
            MY_SECRET_RESOLVER_FOO: "1",
        };
        assert.deepStrictEqual(stripInternalEnvVars(env), env);
    });

    test("does not mutate the input env", () => {
        const env = { SECRET_RESOLVER_X: "1", KEEP: "y" };
        const snapshot = { ...env };
        stripInternalEnvVars(env);
        assert.deepStrictEqual(env, snapshot);
    });
});

suite("parseSecretResolverMode", () => {
    test("returns 'cache' for the literal 'cache' regardless of console", () => {
        for (const consoleKind of ["", "integratedTerminal", "internalConsole"]) {
            assert.strictEqual(
                parseSecretResolverMode("cache", consoleKind),
                "cache",
            );
        }
    });

    test("'cache' is case-insensitive and trims surrounding whitespace", () => {
        for (const v of ["CACHE", " Cache ", "  cache\t"]) {
            assert.strictEqual(
                parseSecretResolverMode(v, "integratedTerminal"),
                "cache",
                `expected "${v}" to parse as "cache"`,
            );
        }
    });

    test("returns 'op' for the literal 'op' regardless of console", () => {
        for (const consoleKind of ["", "integratedTerminal", "internalConsole"]) {
            assert.strictEqual(
                parseSecretResolverMode("op", consoleKind),
                "op",
            );
        }
    });

    test("missing values default to 'cache' for internalConsole", () => {
        assert.strictEqual(
            parseSecretResolverMode(undefined, "internalConsole"),
            "cache",
        );
        assert.strictEqual(
            parseSecretResolverMode(null, "internalConsole"),
            "cache",
        );
        assert.strictEqual(
            parseSecretResolverMode("", "internalConsole"),
            "cache",
        );
    });

    test("missing values default to 'op' for non-internalConsole consoles", () => {
        for (const consoleKind of ["", "integratedTerminal", "externalTerminal"]) {
            assert.strictEqual(
                parseSecretResolverMode(undefined, consoleKind),
                "op",
            );
            assert.strictEqual(parseSecretResolverMode(null, consoleKind), "op");
            assert.strictEqual(parseSecretResolverMode("", consoleKind), "op");
        }
    });

    test("unknown values warn and fall through to the console-derived default", () => {
        const original = console.warn;
        const warnings: unknown[][] = [];

        console.warn = (...args: unknown[]) => {
            warnings.push(args);
        };

        try {
            assert.strictEqual(
                parseSecretResolverMode("foo", "integratedTerminal"),
                "op",
            );
            assert.strictEqual(
                parseSecretResolverMode("1", "internalConsole"),
                "cache",
            );
            assert.strictEqual(
                parseSecretResolverMode("true", "externalTerminal"),
                "op",
            );
        }
        finally {
            console.warn = original;
        }

        assert.strictEqual(warnings.length, 3);
    });
});

suite("mergeEnv", () => {
    test("inline values win over file values", () => {
        assert.deepStrictEqual(
            mergeEnv({ A: "from-file", B: "file-only" }, { A: "from-inline" }),
            { A: "from-inline", B: "file-only" },
        );
    });

    test("file map alone is returned when inline is undefined", () => {
        assert.deepStrictEqual(
            mergeEnv({ A: "x" }, undefined),
            { A: "x" },
        );
    });

    test("does not mutate the inputs", () => {
        const fileMap = { A: "f" };
        const inlineMap = { B: "i" };
        const fileSnap = { ...fileMap };
        const inlineSnap = { ...inlineMap };
        mergeEnv(fileMap, inlineMap);
        assert.deepStrictEqual(fileMap, fileSnap);
        assert.deepStrictEqual(inlineMap, inlineSnap);
    });
});
