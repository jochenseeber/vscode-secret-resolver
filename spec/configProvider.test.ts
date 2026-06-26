import * as assert from "node:assert"

import { type AccountResolverFactory, NullAccountResolver } from "../src/accountResolver"
import {
    OpCliNotFoundError,
    OpInjectAbortedError,
    OpInjectError,
    type OpInjectOptions,
    type OpRunner,
} from "../src/opRunner"
import { type EnvFileReader, LaunchConfigResolver } from "../src/resolveLaunchConfig"
import { ResolverCache } from "../src/resolverCache"
import { SecretCache } from "../src/secretCache"
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "../src/sessionConfig"
import { NullTokenResolver, type TokenResolverFactory } from "../src/tokenResolver"
import type { UserNotifier } from "../src/userNotifier"

class FakeRunner {
    readonly opPath = "fake"
    calls: Array<{ refs: readonly string[]; token: string | undefined; account: string | undefined }> = []
    nextResult: Map<string, string> | Error = new Map()

    async inject(
        refs: readonly string[],
        options: OpInjectOptions = {},
    ): Promise<Map<string, string>> {
        this.calls.push({ refs, token: options.token, account: options.account })

        if (this.nextResult instanceof Error) {
            throw this.nextResult
        }

        return this.nextResult
    }
}

interface Recorder {
    errors: string[]
    warnings: string[]
}

function makeResolver(options: {
    runner?: FakeRunner
    cache?: SecretCache
    files?: Record<string, Record<string, string>>
    resolveTokenForTag?: (tag: string, signal?: AbortSignal, account?: string) => Promise<string>
    resolveAccountForEmail?: (email: string, signal?: AbortSignal) => Promise<string>
    resolveAccountForGitConfig?: (subdirectory: string, signal?: AbortSignal) => Promise<string>
}): { resolver: LaunchConfigResolver; recorder: Recorder; cache: SecretCache } {
    const recorder: Recorder = { errors: [], warnings: [] }
    const cache = options.cache ?? new SecretCache()
    const runner = options.runner ?? new FakeRunner()
    const files = options.files ?? {}

    const envFileReader: EnvFileReader = {
        parse: async (p: string) => {
            if (p in files) {
                return files[p]
            }

            const { EnvFileNotFoundError } = await import(
                "../src/dotenv"
            )
            throw new EnvFileNotFoundError(p)
        },
    }

    const notifier: UserNotifier = {
        showError: (message) => {
            recorder.errors.push(message)
        },
        showWarning: (message) => {
            recorder.warnings.push(message)
        },
    }

    const accountResolverFactory: AccountResolverFactory = {
        createForEmail: options.resolveAccountForEmail !== undefined
            ? (email) => ({ resolve: (signal?: AbortSignal) => options.resolveAccountForEmail!(email, signal) })
            : () => new NullAccountResolver(),
        createForGitConfig: options.resolveAccountForGitConfig !== undefined
            ? (subdirectory, _workspacePath) => ({
                resolve: (signal?: AbortSignal) => options.resolveAccountForGitConfig!(subdirectory, signal),
            })
            : (_subdirectory, _workspacePath) => new NullAccountResolver(),
    }

    const tokenResolverFactory: TokenResolverFactory = {
        createForTag: options.resolveTokenForTag !== undefined
            ? (tag) => ({
                resolve: (accountId: string | undefined, signal?: AbortSignal) =>
                    options.resolveTokenForTag!(tag, signal, accountId),
            })
            : () => new NullTokenResolver(),
    }

    const resolver = new LaunchConfigResolver(
        new ResolverCache(cache),
        runner as unknown as OpRunner,
        envFileReader,
        notifier,
        accountResolverFactory,
        tokenResolverFactory,
        { isTrusted: () => true },
    )

    return { resolver, recorder, cache }
}

suite("LaunchConfigResolver", () => {
    test("returns config unchanged when neither env nor envFile is present", async () => {
        const { resolver } = makeResolver({})
        const config = { type: "node", name: "x", request: "launch" }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result, config)
    })

    test("returns config unchanged for non-map env shapes", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "cppdbg",
            name: "x",
            request: "launch",
            environment: [{ name: "DB", value: "op://x/y/z" }],
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result, config)
    })

    test("strips SECRET_RESOLVER_* keys even when no refs are present", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                SECRET_RESOLVER_DEBUG: "1",
                SECRET_RESOLVER_MODE: "cache",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
    })

    test("resolves op:// refs via op inject and replaces them in env", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([
            ["op://v/i/db", "DB-VALUE"],
            ["op://v/i/api", "API-VALUE"],
        ])
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                DB: "op://v/i/db",
                API: "op://v/i/api",
                PLAIN: "literal",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, {
            DB: "DB-VALUE",
            API: "API-VALUE",
            PLAIN: "literal",
        })
        assert.deepStrictEqual(runner.calls, [
            { refs: ["op://v/i/db", "op://v/i/api"], token: undefined, account: undefined },
        ])
    })

    test("uses cached resolutions on a second call without re-spawning op", async () => {
        const cache = new SecretCache()
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({ runner, cache })

        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        await resolver.resolve(config, undefined)
        runner.nextResult = new Map() // would resolve nothing on a second call
        const second = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(second?.env, { DB: "DB-VALUE" })
        assert.strictEqual(runner.calls.length, 1)
    })

    test("merges envFile with inline env, inline wins, then resolves", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([
            ["op://v/i/inline", "INLINE-VALUE"],
            ["op://v/i/file", "FILE-VALUE"],
        ])
        const { resolver } = makeResolver({
            runner,
            files: {
                "/tmp/.env": {
                    SHARED: "from-file",
                    FILE_ONLY: "op://v/i/file",
                },
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { SHARED: "from-inline", INLINE_ONLY: "op://v/i/inline" },
            envFile: "/tmp/.env",
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, {
            SHARED: "from-inline",
            FILE_ONLY: "FILE-VALUE",
            INLINE_ONLY: "INLINE-VALUE",
        })
        assert.ok(
            !("envFile" in (result ?? {})),
            "envFile should be removed after merging",
        )
    })

    test("warns and continues on missing envFile", async () => {
        const { resolver, recorder } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { K: "v" },
            envFile: "/no/such/.env",
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { K: "v" })
        assert.strictEqual(recorder.warnings.length, 1)
        assert.match(recorder.warnings[0], /envFile not found/)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("SECRET_RESOLVER_MODE is ignored: terminal console resolves refs via op inject", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_MODE: "op",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
    })

    test("SECRET_RESOLVER_MODE=op + internalConsole no longer aborts; resolves via op inject", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_MODE: "op",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("default (unset) MODE + internalConsole resolves via op inject (cache default)", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("MODE=cache + internalConsole resolves via op inject", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_MODE: "cache",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
    })

    test("cache mode is the default for terminal consoles when MODE is unset", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
    })

    test("MODE=cache with integratedTerminal resolves via inject", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_MODE: "cache",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
    })

    test("aborts the launch when op inject returns ENOENT", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new OpCliNotFoundError("/no/op")
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /1Password CLI not found/)
    })

    test("aborts the launch when op inject exits non-zero", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new OpInjectError(
            "op inject failed: not signed in",
            "not signed in",
            1,
        )
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.match(recorder.errors[0], /op inject failed: not signed in/)
    })

    test("aborts silently (no error UI) when the resolution is cancelled", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new OpInjectAbortedError()
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("aborts when op inject does not return all requested refs", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver, recorder } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                DB: "op://v/i/db",
                API: "op://v/i/api",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.match(recorder.errors[0], /did not return values for/)
    })

    test("attaches __secretResolver session config when SIGNAL_ON_STOP is set on a terminal launch", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_SIGNAL_ON_STOP: "TERM+5:KILL",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)

        const sessionConfig = (result as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.deepStrictEqual(sessionConfig, {
            steps: [
                { delaySec: 0, signal: "TERM" },
                { delaySec: 5, signal: "KILL" },
            ],
        })
        // Internal env vars are still stripped from `env`.
        assert.deepStrictEqual(result?.env, { FOO: "bar" })
    })

    test("uses DEFAULT_STEP_DELAY_SECONDS when no explicit delay between steps", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_SIGNAL_ON_STOP: "TERM+KILL",
            },
        }
        const result = await resolver.resolve(config, undefined)
        const sessionConfig = (result as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.deepStrictEqual(sessionConfig, {
            steps: [
                { delaySec: 0, signal: "TERM" },
                { delaySec: 30, signal: "KILL" },
            ],
        })
    })

    test("does not attach __secretResolver when SIGNAL_ON_STOP is unset", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("does not attach __secretResolver when SIGNAL_ON_STOP is 'off'", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_SIGNAL_ON_STOP: "off",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("attaches __secretResolver for internalConsole when signal steps are configured", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map()
        const { resolver } = makeResolver({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_SIGNAL_ON_STOP: "TERM+KILL",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        const sessionConfig = (result as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.deepStrictEqual(sessionConfig, {
            steps: [
                { delaySec: 0, signal: "TERM" },
                { delaySec: 30, signal: "KILL" },
            ],
        })
    })

    test("TOKEN_TAG_VAR is stripped from final env and ignored when no op refs are present", async () => {
        let tokenCalls = 0
        const { resolver } = makeResolver({
            resolveTokenForTag: async () => {
                tokenCalls++
                return "tok"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_TOKEN_TAG" in (result!.env as Record<string, unknown>)))
        assert.strictEqual(tokenCalls, 0)
    })

    test("token is passed as 4th arg to runner.resolve in cache mode", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveTokenForTag: async () => "my-token",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
            },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(runner.calls[0].token, "my-token")
    })

    test("token resolution failure aborts launch with error", async () => {
        const { resolver, recorder } = makeResolver({
            resolveTokenForTag: async () => {
                throw new Error("vault not found")
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /vault not found/)
    })

    test("token tag alone does not attach __secretResolver (terminal launch)", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveTokenForTag: async () => "tok",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("token tag alone does not attach __secretResolver (internalConsole)", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map()
        const { resolver } = makeResolver({
            runner,
            resolveTokenForTag: async () => "tok",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("ACCOUNT_ID_VAR is used as the literal account id and stripped from final env", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_ID: "SOME_ACCOUNT_ID",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_ACCOUNT_ID" in (result!.env as Record<string, unknown>)))
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "SOME_ACCOUNT_ID")
    })

    test("accountId is forwarded as 4th arg to resolveTokenForTag", async () => {
        const tokenTagCalls: Array<{ tag: string; account: string | undefined }> = []
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveAccountForEmail: async () => "SOME_ACCOUNT_ID",
            resolveTokenForTag: async (tag, _signal, account) => {
                tokenTagCalls.push({ tag, account })
                return "tok"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(tokenTagCalls.length, 1)
        assert.strictEqual(tokenTagCalls[0].account, "SOME_ACCOUNT_ID")
    })

    test("accountId is forwarded as 5th arg to runner.resolve", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveAccountForEmail: async () => "SOME_ACCOUNT_ID",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(runner.calls[0].account, "SOME_ACCOUNT_ID")
    })

    test("accountId is attached to __secretResolver for terminal launches", async () => {
        const { resolver } = makeResolver({
            resolveAccountForEmail: async () => "SOME_ACCOUNT_ID",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        const sessionConfig = (result! as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.ok(sessionConfig)
        assert.strictEqual(sessionConfig!.accountId, "SOME_ACCOUNT_ID")
        assert.deepStrictEqual(sessionConfig!.steps, [])
    })

    test("accountId is attached to __secretResolver for internalConsole", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map()
        const { resolver } = makeResolver({
            runner,
            resolveAccountForEmail: async () => "SOME_ACCOUNT_ID",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        const sessionConfig = (result as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.ok(sessionConfig)
        assert.strictEqual(sessionConfig!.accountId, "SOME_ACCOUNT_ID")
    })

    test("ACCOUNT_EMAIL_VAR is stripped from final env", async () => {
        const { resolver } = makeResolver({
            resolveAccountForEmail: async () => "acct-uuid-from-email",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_ACCOUNT_EMAIL" in (result!.env as Record<string, unknown>)))
    })

    test("accountId resolved from email is forwarded to resolveTokenForTag", async () => {
        const tokenTagCalls: Array<{ tag: string; account: string | undefined }> = []
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveAccountForEmail: async () => "acct-uuid-from-email",
            resolveTokenForTag: async (tag, _signal, account) => {
                tokenTagCalls.push({ tag, account })
                return "tok"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_TOKEN_TAG: "my-tag",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(tokenTagCalls.length, 1)
        assert.strictEqual(tokenTagCalls[0].account, "acct-uuid-from-email")
    })

    test("accountId resolved from email is forwarded to runner.resolve", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            resolveAccountForEmail: async () => "acct-uuid-from-email",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: {
                DB: "op://v/i/db",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(runner.calls[0].account, "acct-uuid-from-email")
    })

    test("accountId from email is attached to __secretResolver for terminal launches", async () => {
        const { resolver } = makeResolver({
            resolveAccountForEmail: async () => "acct-uuid-from-email",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        const sessionConfig = (result! as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.ok(sessionConfig)
        assert.strictEqual(sessionConfig!.accountId, "acct-uuid-from-email")
        assert.deepStrictEqual(sessionConfig!.steps, [])
    })

    test("ACCOUNT_GIT_CONFIG_VAR takes priority over ACCOUNT_EMAIL_VAR when both are set", async () => {
        const emailResolverCalls: string[] = []
        const { resolver } = makeResolver({
            resolveAccountForEmail: async (value) => {
                emailResolverCalls.push(value)
                return "acct-uuid-from-email"
            },
            resolveAccountForGitConfig: async () => "acct-uuid-from-git",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: ".",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(emailResolverCalls.length, 0)
        const sessionConfig = (result! as Record<string, unknown>)[
            SECRET_RESOLVER_CONFIG_FIELD
        ] as SecretResolverSessionConfig | undefined
        assert.ok(sessionConfig)
        assert.strictEqual(sessionConfig!.accountId, "acct-uuid-from-git")
    })

    test("error from resolveAccountForEmail aborts launch with error message", async () => {
        const { resolver, recorder } = makeResolver({
            resolveAccountForEmail: async () => {
                throw new Error("no matching 1Password account")
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                FOO: "bar",
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /no matching 1Password account/)
    })
})
