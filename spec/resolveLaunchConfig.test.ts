import * as assert from "node:assert"

import { MODE_VAR, SIGNAL_ON_STOP_VAR, type StringEnvMap, TOKEN_TAG_VAR } from "../src/envHelpers"
import { OpCliNotFoundError, OpInjectAbortedError, OpInjectError, type OpInjectOptions } from "../src/opRunner"
import { type ResolveDeps, resolveLaunchConfig } from "../src/resolveLaunchConfig"
import { SecretCache } from "../src/secretCache"
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "../src/sessionConfig"

class FakeRunner {
    readonly opPath = "fake"
    calls: Array<readonly string[]> = []
    nextResult: Map<string, string> | Error = new Map()

    async inject(refs: readonly string[], _options: OpInjectOptions = {}): Promise<Map<string, string>> {
        this.calls.push(refs)

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

function makeDeps(opts: {
    runner?: FakeRunner
    cache?: SecretCache
    files?: Record<string, StringEnvMap>
    resolveTokenForTag?: (tag: string, signal?: AbortSignal, account?: string) => Promise<string>
    resolveAccountForEmail?: (email: string, signal?: AbortSignal) => Promise<string>
    resolveAccountForGitConfig?: (subdir: string, signal?: AbortSignal) => Promise<string>
}): { deps: ResolveDeps; recorder: Recorder; cache: SecretCache } {
    const recorder: Recorder = { errors: [], warnings: [] }
    const cache = opts.cache ?? new SecretCache()
    const runner = opts.runner ?? new FakeRunner()
    const files = opts.files ?? {}
    const deps: ResolveDeps = {
        cache,
        // FakeRunner satisfies the structural shape ResolveDeps.runner requires
        // (opPath + inject). Cast needed because FakeRunner omits the list/get methods.
        runner: runner as unknown as ResolveDeps["runner"],
        parseEnvFile: async (p: string) => {
            if (p in files) {
                return files[p]
            }

            const { EnvFileNotFoundError } = await import(
                "../src/dotenv"
            )
            throw new EnvFileNotFoundError(p)
        },
        showError: (m) => {
            recorder.errors.push(m)
        },
        showWarning: (m) => {
            recorder.warnings.push(m)
        },
        resolveTokenForTag: opts.resolveTokenForTag,
        resolveAccountForEmail: opts.resolveAccountForEmail,
        resolveAccountForGitConfig: opts.resolveAccountForGitConfig,
    }

    return { deps, recorder, cache }
}

suite("resolveLaunchConfig", () => {
    test("returns config unchanged when neither env nor envFile is present", async () => {
        const { deps } = makeDeps({})
        const config = { type: "node", name: "x", request: "launch" }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result, config)
    })

    test("returns config unchanged for non-map env shapes", async () => {
        const { deps } = makeDeps({})
        const config = {
            type: "cppdbg",
            name: "x",
            request: "launch",
            environment: [{ name: "DB", value: "op://x/y/z" }],
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result, config)
    })

    test("strips SECRET_RESOLVER_* keys even when no refs are present", async () => {
        const { deps } = makeDeps({})
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
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
    })

    test("resolves op:// refs via op inject and replaces them in env", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([
            ["op://v/i/db", "DB-VALUE"],
            ["op://v/i/api", "API-VALUE"],
        ])
        const { deps } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, {
            DB: "DB-VALUE",
            API: "API-VALUE",
            PLAIN: "literal",
        })
        assert.deepStrictEqual(runner.calls, [[
            "op://v/i/db",
            "op://v/i/api",
        ]])
    })

    test("uses cached resolutions on a second call without re-spawning op", async () => {
        const cache = new SecretCache()
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { deps } = makeDeps({ runner, cache })

        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        await resolveLaunchConfig(config, deps)
        runner.nextResult = new Map() // would resolve nothing on a second call
        const second = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(second?.env, { DB: "DB-VALUE" })
        assert.strictEqual(runner.calls.length, 1)
    })

    test("merges envFile with inline env, inline wins, then resolves", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([
            ["op://v/i/inline", "INLINE-VALUE"],
            ["op://v/i/file", "FILE-VALUE"],
        ])
        const { deps } = makeDeps({
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
        const result = await resolveLaunchConfig(config, deps)
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
        const { deps, recorder } = makeDeps({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { K: "v" },
            envFile: "/no/such/.env",
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { K: "v" })
        assert.strictEqual(recorder.warnings.length, 1)
        assert.match(recorder.warnings[0], /envFile not found/)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("routes invalid parser values through launch warnings", async () => {
        const { deps, recorder } = makeDeps({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: {
                KEEP: "yes",
                [MODE_VAR]: "wat",
                [SIGNAL_ON_STOP_VAR]: "TERM+NOPE",
            },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { KEEP: "yes" })
        assert.strictEqual(recorder.warnings.length, 2)
        assert.match(recorder.warnings[0], /unknown SECRET_RESOLVER_MODE/)
        assert.match(recorder.warnings[1], /unknown signal/)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("op-run mode: terminal console + MODE=op leaves refs intact", async () => {
        const runner = new FakeRunner()
        const { deps } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { DB: "op://v/i/db" })
        assert.strictEqual(runner.calls.length, 0)
    })

    test("MODE=op + internalConsole aborts with an error", async () => {
        const runner = new FakeRunner()
        const { deps, recorder } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.strictEqual(result, undefined)
        assert.strictEqual(runner.calls.length, 0)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(
            recorder.errors[0],
            /SECRET_RESOLVER_MODE="op".*internalConsole/,
        )
    })

    test("default (unset) MODE + internalConsole resolves via op inject (cache default)", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { deps, recorder } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "internalConsole",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("MODE=cache + internalConsole resolves via op inject", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { deps } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
    })

    test("cache mode is the default for terminal consoles when MODE is unset", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "RESOLVED"]])
        const { deps } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { DB: "RESOLVED" })
        assert.strictEqual(runner.calls.length, 1)
    })

    test("MODE=op on a terminal console leaves refs intact", async () => {
        const runner = new FakeRunner()
        const { deps } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { DB: "op://v/i/db" })
        assert.strictEqual(runner.calls.length, 0)
    })

    test("aborts the launch when op inject returns ENOENT", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new OpCliNotFoundError("/no/op")
        const { deps, recorder } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolveLaunchConfig(config, deps)
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
        const { deps, recorder } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.strictEqual(result, undefined)
        assert.match(recorder.errors[0], /op inject failed: not signed in/)
    })

    test("aborts silently (no error UI) when the resolution is cancelled", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new OpInjectAbortedError()
        const { deps, recorder } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: { DB: "op://v/i/db" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 0)
    })

    test("aborts when op inject does not return all requested refs", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map([["op://v/i/db", "DB-VALUE"]])
        const { deps, recorder } = makeDeps({ runner })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            env: {
                DB: "op://v/i/db",
                API: "op://v/i/api",
            },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.strictEqual(result, undefined)
        assert.match(recorder.errors[0], /did not return values for/)
    })

    test("attaches __secretResolver session config when SIGNAL_ON_STOP is set on a terminal launch", async () => {
        const { deps } = makeDeps({})
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
        const result = await resolveLaunchConfig(config, deps)
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
        const { deps } = makeDeps({})
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
        const result = await resolveLaunchConfig(config, deps)
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
        const { deps } = makeDeps({})
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("does not attach __secretResolver when SIGNAL_ON_STOP is 'off'", async () => {
        const { deps } = makeDeps({})
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
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("does not attach __secretResolver for internalConsole", async () => {
        const runner = new FakeRunner()
        runner.nextResult = new Map()
        const { deps } = makeDeps({ runner })
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
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })

    test("ACCOUNT_EMAIL_VAR resolves plain email address and strips var from env", async () => {
        const { deps } = makeDeps({
            resolveAccountForEmail: async () => "acct-uuid-from-email",
        })
        const config = {
            type: "node",
            name: "x",
            request: "launch",
            console: "integratedTerminal",
            env: { FOO: "bar", SECRET_RESOLVER_ACCOUNT_EMAIL: "user@example.com" },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.ok(!("SECRET_RESOLVER_ACCOUNT_EMAIL" in (result!.env as Record<string, unknown>)))
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-uuid-from-email")
    })

    test("ACCOUNT_GIT_CONFIG_VAR resolves via resolveAccountForGitConfig and strips var from env", async () => {
        const gitConfigCalls: string[] = []
        const { deps } = makeDeps({
            resolveAccountForGitConfig: async (subdir) => {
                gitConfigCalls.push(subdir)
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
        const result = await resolveLaunchConfig(config, deps)
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
        const { deps } = makeDeps({
            resolveAccountForGitConfig: async (subdir) => {
                gitConfigCalls.push(subdir)
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
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.strictEqual(gitConfigCalls.length, 0)
    })

    test("ACCOUNT_EMAIL_VAR takes priority over ACCOUNT_GIT_CONFIG_VAR", async () => {
        const gitConfigCalls: string[] = []
        const { deps } = makeDeps({
            resolveAccountForEmail: async () => "acct-uuid-from-email",
            resolveAccountForGitConfig: async (subdir) => {
                gitConfigCalls.push(subdir)
                return "acct-uuid-from-git"
            },
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
        const result = await resolveLaunchConfig(config, deps)
        assert.ok(result)
        assert.strictEqual(gitConfigCalls.length, 0)
        const sessionConfig = (result as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] as
            | SecretResolverSessionConfig
            | undefined
        assert.strictEqual(sessionConfig?.accountId, "acct-uuid-from-email")
    })

    test("error from resolveAccountForGitConfig aborts launch with error message", async () => {
        const { deps, recorder } = makeDeps({
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
        const result = await resolveLaunchConfig(config, deps)
        assert.strictEqual(result, undefined)
        assert.strictEqual(recorder.errors.length, 1)
        assert.match(recorder.errors[0], /no matching 1Password account/)
    })

    test("does not resolve service account token when stripped env has no op refs", async () => {
        let tokenCalls = 0
        const { deps } = makeDeps({
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
                [TOKEN_TAG_VAR]: "my-tag",
            },
        }
        const result = await resolveLaunchConfig(config, deps)
        assert.deepStrictEqual(result?.env, { FOO: "bar" })
        assert.strictEqual(tokenCalls, 0)
        assert.strictEqual(
            SECRET_RESOLVER_CONFIG_FIELD in (result as Record<string, unknown>),
            false,
        )
    })
})
