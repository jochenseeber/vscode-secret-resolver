import * as assert from "node:assert"

import { type AccountResolverFactory, NullAccountResolver } from "../src/accountResolver"
import {
    OpCliNotFoundError,
    OpInjectAbortedError,
    OpInjectError,
    type OpInjectOptions,
    OpRunner,
} from "../src/opRunner"
import { type EnvFileReader, LaunchConfigResolver, type ResolverSettings } from "../src/resolveLaunchConfig"
import { ResolverCache } from "../src/resolverCache"
import { SecretCache } from "../src/secretCache"
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "../src/sessionConfig"
import { NullTokenResolver, type TokenResolverFactory } from "../src/tokenResolver"
import type { UserNotifier } from "../src/userNotifier"

class FakeRunner {
    readonly opPath = "fake"
    calls: Array<{ refs: readonly string[]; token: string | undefined; account: string | undefined }> = []
    nextResult: Map<string, string> | Error = new Map()

    async inject(refs: readonly string[], options: OpInjectOptions = {}): Promise<Map<string, string>> {
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
    workspaceTrusted?: boolean
    settings?: ResolverSettings
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
        { isTrusted: () => options.workspaceTrusted ?? true },
        { read: () => options.settings ?? {} },
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
        assert.deepStrictEqual(runner.calls, [{
            refs: ["op://v/i/db", "op://v/i/api"],
            token: undefined,
            account: undefined,
        }])
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

    test("routes invalid signal-on-stop values through launch warnings", async () => {
        const { resolver, recorder } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                KEEP: "yes",
                SECRET_RESOLVER_SIGNAL_ON_STOP: "TERM+NOPE",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
        assert.strictEqual(recorder.warnings.length, 1)
        assert.match(recorder.warnings[0], /invalid SECRET_RESOLVER_SIGNAL_ON_STOP/)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
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

    test("ACCOUNT_EMAIL_VAR resolves plain email address and strips var from env", async () => {
        const { resolver } = makeResolver({
            resolveAccountForEmail: async () => "acct-uuid-from-email",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_ACCOUNT_EMAIL" in (result!.env as Record<string, unknown>)))
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-uuid-from-email")
    })

    test("ACCOUNT_GIT_CONFIG_VAR resolves via resolveAccountForGitConfig and strips var from env", async () => {
        const gitConfigCalls: string[] = []
        const { resolver } = makeResolver({
            resolveAccountForGitConfig: async (subdirectory) => {
                gitConfigCalls.push(subdirectory)
                return "acct-uuid-from-git"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: "." },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_ACCOUNT_GIT_CONFIG" in (result!.env as Record<string, unknown>)))
        assert.deepStrictEqual(gitConfigCalls, ["."])
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-uuid-from-git")
    })

    test("empty ACCOUNT_GIT_CONFIG_VAR is treated as off", async () => {
        const gitConfigCalls: string[] = []
        const { resolver } = makeResolver({
            resolveAccountForGitConfig: async (subdirectory) => {
                gitConfigCalls.push(subdirectory)
                return "acct-uuid-from-git"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: "" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(gitConfigCalls.length, 0)
    })

    test("ACCOUNT_GIT_CONFIG_VAR takes priority over ACCOUNT_EMAIL_VAR", async () => {
        const emailCalls: string[] = []
        const { resolver } = makeResolver({
            resolveAccountForEmail: async (email) => {
                emailCalls.push(email)
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
                SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com",
                SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: ".",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(emailCalls.length, 0)
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-uuid-from-git")
    })

    test("error from resolveAccountForGitConfig aborts launch with error message", async () => {
        const { resolver, recorder } = makeResolver({
            resolveAccountForGitConfig: async () => {
                throw new Error("no matching 1Password account")
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: "." },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /no matching 1Password account/)
    })

    test("does not resolve service account token when stripped env has no op refs", async () => {
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
        assert.deepStrictEqual(result?.env, { FOO: "bar" })
        assert.strictEqual(tokenCalls, 0)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("re-runs op inject when a cached ref is requested under a different account", async () => {
        const cache = new SecretCache()
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "PERSONAL-VALUE"]])
        const { resolver } = makeResolver({ runner, cache })

        await resolver.resolve(
            { type: "node", name: "x", request: "launch", env: { DB: "op://v/i/db" } },
            undefined,
        )

        runner.nextResult = new Map([["op://v/i/db", "WORK-VALUE"]])
        const second = await resolver.resolve(
            {
                type: "node",
                name: "x",
                request: "launch",
                env: {
                    DB: "op://v/i/db",
                    SECRET_RESOLVER_ACCOUNT_ID: "WORK_ACCOUNT",
                },
            },
            undefined,
        )

        assert.strictEqual(runner.calls.length, 2)
        assert.strictEqual(runner.calls[1].account, "WORK_ACCOUNT")
        assert.deepStrictEqual(second?.env, { DB: "WORK-VALUE" })
    })

    test("re-runs op inject when a cached ref is requested under a different token tag", async () => {
        const cache = new SecretCache()
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "UNTAGGED-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            cache,
            resolveTokenForTag: async () => "tok",
        })

        await resolver.resolve(
            { type: "node", name: "x", request: "launch", env: { DB: "op://v/i/db" } },
            undefined,
        )

        runner.nextResult = new Map([["op://v/i/db", "TAGGED-VALUE"]])
        const second = await resolver.resolve(
            {
                type: "node",
                name: "x",
                request: "launch",
                env: {
                    DB: "op://v/i/db",
                    SECRET_RESOLVER_TOKEN_TAG: "ci-tag",
                },
            },
            undefined,
        )

        assert.strictEqual(runner.calls.length, 2)
        assert.strictEqual(runner.calls[1].token, "tok")
        assert.deepStrictEqual(second?.env, { DB: "TAGGED-VALUE" })
    })

    test("removes a pre-existing __secretResolver field from the incoming config", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { FOO: "bar" },
            [SECRET_RESOLVER_CONFIG_FIELD]: { steps: [{ delaySec: 0, signal: "KILL" }] },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(SECRET_RESOLVER_CONFIG_FIELD in result!, false)
        assert.deepStrictEqual(result?.env, { FOO: "bar" })
    })

    test("removes a pre-existing __secretResolver field even when no env is present", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            [SECRET_RESOLVER_CONFIG_FIELD]: { steps: [{ delaySec: 0, signal: "KILL" }] },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(SECRET_RESOLVER_CONFIG_FIELD in result!, false)
    })

    test("aborts with an error when the workspace is not trusted and env is present", async () => {
        const runner = new FakeRunner()
        const { resolver, recorder } = makeResolver({ runner, workspaceTrusted: false })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(result, undefined)
        assert.strictEqual(runner.calls.length, 0)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /not trusted/)
    })

    test("returns config unchanged in an untrusted workspace when there is no env to resolve", async () => {
        const { resolver, recorder } = makeResolver({ workspaceTrusted: false })
        const config = { type: "node", name: "x", request: "launch" }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result, config)
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

    test("forwards the resolved service-account token to op inject", async () => {
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

    test("forwards the resolved accountId to the token resolver", async () => {
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

    test("forwards the resolved accountId to op inject", async () => {
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

    test("sanitizeVars strips matching variable names from the final env", async () => {
        const { resolver } = makeResolver({
            settings: { sanitizeVars: "^(OP_|SECRET_RESOLVER_)" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                OP_SERVICE_ACCOUNT_TOKEN: "secret",
                OP_CONNECT_HOST: "http://localhost",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
    })

    test("unset sanitizeVars applies the default, stripping OP_ and SECRET_RESOLVER_", async () => {
        const { resolver } = makeResolver({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                OP_TOKEN: "gone",
                SECRET_RESOLVER_TOKEN_TAG: "tag",
            },
        }
        const result = await resolver.resolve(config, undefined)
        // Nothing configured: the default pattern removes OP_ and SECRET_RESOLVER_.
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
    })

    test("env SECRET_RESOLVER_SANITIZE_VARS overrides settings.sanitizeVars", async () => {
        const { resolver } = makeResolver({
            settings: { sanitizeVars: "^(OP_|SECRET_RESOLVER_)" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                OP_TOKEN: "now-kept",
                DROP_ME: "gone",
                SECRET_RESOLVER_SANITIZE_VARS: "^(DROP_|SECRET_RESOLVER_)",
            },
        }
        const result = await resolver.resolve(config, undefined)
        // env pattern wins: DROP_ and the markers removed, OP_ now kept.
        assert.deepStrictEqual(result?.env, { KEEP: "yes", OP_TOKEN: "now-kept" })
    })

    test("empty SECRET_RESOLVER_SANITIZE_VARS disables all stripping", async () => {
        const { resolver } = makeResolver({
            settings: { sanitizeVars: "^OP_" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                OP_TOKEN: "kept",
                SECRET_RESOLVER_TOKEN_TAG: "kept-too",
                SECRET_RESOLVER_SANITIZE_VARS: "",
            },
        }
        const result = await resolver.resolve(config, undefined)
        // Disabling turns off every strip, so even the markers pass through.
        assert.deepStrictEqual(result?.env, {
            KEEP: "yes",
            OP_TOKEN: "kept",
            SECRET_RESOLVER_TOKEN_TAG: "kept-too",
            SECRET_RESOLVER_SANITIZE_VARS: "",
        })
    })

    test("invalid sanitizeVars regexp warns and falls back to the default pattern", async () => {
        const { resolver, recorder } = makeResolver({
            settings: { sanitizeVars: "[" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                KEEP: "yes",
                OP_TOKEN: "should-be-dropped-by-default",
            },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
        assert.strictEqual(recorder.warnings.length, 1)
        assert.match(recorder.warnings[0], /invalid SECRET_RESOLVER_SANITIZE_VARS/)
    })

    test("settings.signalOnStop provides signal steps when no env var is set", async () => {
        const { resolver } = makeResolver({
            settings: { signalOnStop: "TERM+5:KILL" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolver.resolve(config, undefined)
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.deepStrictEqual(sessionConfig?.steps, [
            { delaySec: 0, signal: "TERM" },
            { delaySec: 5, signal: "KILL" },
        ])
    })

    test("env SECRET_RESOLVER_SIGNAL_ON_STOP overrides settings.signalOnStop", async () => {
        const { resolver } = makeResolver({
            settings: { signalOnStop: "TERM+KILL" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_SIGNAL_ON_STOP: "INT" },
        }
        const result = await resolver.resolve(config, undefined)
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.deepStrictEqual(sessionConfig?.steps, [{ delaySec: 0, signal: "INT" }])
    })

    test("empty env SECRET_RESOLVER_SIGNAL_ON_STOP switches settings.signalOnStop off", async () => {
        const { resolver } = makeResolver({
            settings: { signalOnStop: "TERM+KILL" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_SIGNAL_ON_STOP: "" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("settings.tokenTag is used as the token tag when no env var is set", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const tokenTagCalls: string[] = []
        const { resolver } = makeResolver({
            runner,
            settings: { tokenTag: "settings-tag" },
            resolveTokenForTag: async (tag) => {
                tokenTagCalls.push(tag)
                return "settings-token"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: { DB: "op://v/i/db" },
        }
        await resolver.resolve(config, undefined)
        assert.deepStrictEqual(tokenTagCalls, ["settings-tag"])
        assert.strictEqual(runner.calls[0].token, "settings-token")
    })

    test("env SECRET_RESOLVER_TOKEN_TAG overrides settings.tokenTag", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const tokenTagCalls: string[] = []
        const { resolver } = makeResolver({
            runner,
            settings: { tokenTag: "settings-tag" },
            resolveTokenForTag: async (tag) => {
                tokenTagCalls.push(tag)
                return "tok"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: { DB: "op://v/i/db", SECRET_RESOLVER_TOKEN_TAG: "env-tag" },
        }
        await resolver.resolve(config, undefined)
        assert.deepStrictEqual(tokenTagCalls, ["env-tag"])
    })

    test("settings.accountId is used as the literal account when no env var is set", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { resolver } = makeResolver({
            runner,
            settings: { accountId: "SETTINGS_ACCOUNT" },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: { DB: "op://v/i/db" },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(runner.calls[0].account, "SETTINGS_ACCOUNT")
    })

    test("settings.accountEmail is resolved when no env var is set", async () => {
        const emailCalls: string[] = []
        const { resolver } = makeResolver({
            settings: { accountEmail: "settings@example.com" },
            resolveAccountForEmail: async (email) => {
                emailCalls.push(email)
                return "acct-from-settings-email"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(emailCalls, ["settings@example.com"])
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-from-settings-email")
    })

    test("settings.accountGitConfig is resolved when no env var is set", async () => {
        const gitConfigCalls: string[] = []
        const { resolver } = makeResolver({
            settings: { accountGitConfig: "packages/api" },
            resolveAccountForGitConfig: async (subdirectory) => {
                gitConfigCalls.push(subdirectory)
                return "acct-from-settings-git"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.deepStrictEqual(gitConfigCalls, ["packages/api"])
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-from-settings-git")
    })

    test("env SECRET_RESOLVER_ACCOUNT_EMAIL overrides settings.accountEmail", async () => {
        const emailCalls: string[] = []
        const { resolver } = makeResolver({
            settings: { accountEmail: "settings@example.com" },
            resolveAccountForEmail: async (email) => {
                emailCalls.push(email)
                return "acct"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_EMAIL: "env@example.com" },
        }
        await resolver.resolve(config, undefined)
        assert.deepStrictEqual(emailCalls, ["env@example.com"])
    })

    test("an explicitly empty env var switches a setting-provided marker off", async () => {
        const gitConfigCalls: string[] = []
        const { resolver } = makeResolver({
            settings: { accountGitConfig: "." },
            resolveAccountForGitConfig: async (subdirectory) => {
                gitConfigCalls.push(subdirectory)
                return "acct-from-git"
            },
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_GIT_CONFIG: "" },
        }
        await resolver.resolve(config, undefined)
        assert.strictEqual(gitConfigCalls.length, 0)
    })

    test("settings.accountGitConfig takes priority over settings.accountEmail", async () => {
        const emailCalls: string[] = []
        const { resolver } = makeResolver({
            settings: { accountGitConfig: ".", accountEmail: "settings@example.com" },
            resolveAccountForEmail: async (email) => {
                emailCalls.push(email)
                return "acct-from-email"
            },
            resolveAccountForGitConfig: async () => "acct-from-git",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolver.resolve(config, undefined)
        assert.strictEqual(emailCalls.length, 0)
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-from-git")
    })
})
