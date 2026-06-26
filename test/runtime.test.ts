import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import * as vscode from "vscode"

import { DebugProtocol } from "@vscode/debugprotocol"
import { SecretDebugAdapterTrackerFactory } from "../src/debugAdapterProxy"
import { DotenvFile } from "../src/dotenv"
import type { ProcessFinder, ProcessTreeReader } from "../src/processTree"
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "../src/sessionConfig"
import type { ProcessController } from "../src/stopSignalController"
import { InMemoryTempDirRegistry, TEMP_DIR_PREFIX, type TempDirRegistry } from "../src/tempDirRegistry"

interface KillCall {
    pid: number
    signal: NodeJS.Signals | number
}

interface ScheduledTimer {
    id: NodeJS.Timeout
    cb: () => void
    ms: number
    canceled: boolean
}

function makeTrackerWithStubs(opts?: {
    registry?: TempDirRegistry
    sessionConfig?: SecretResolverSessionConfig
    treeByRoot?: Map<number, number[]>
    /** PID the stub `ProcessFinder` reports for any marker (default: null). */
    pidByMarker?: number | null
}): {
    tracker: vscode.DebugAdapterTracker | undefined
    kills: KillCall[]
    timers: ScheduledTimer[]
    treeByRoot: Map<number, number[]>
    warnings: string[]
    markerQueries: string[]
    fireTimer: (idx: number) => void
} {
    const registry = opts?.registry ?? new InMemoryTempDirRegistry()
    const kills: KillCall[] = []
    const timers: ScheduledTimer[] = []
    const warnings: string[] = []
    const markerQueries: string[] = []
    const treeByRoot = opts?.treeByRoot ?? new Map()

    const processController: ProcessController = {
        kill: (pid, signal) => {
            kills.push({ pid, signal })
        },
        setTimer: (cb: () => void, ms: number): NodeJS.Timeout => {
            const id = {} as NodeJS.Timeout
            timers.push({ id, cb, ms, canceled: false })
            return id
        },
        clearTimer: (handle: NodeJS.Timeout) => {
            for (const t of timers) {
                if (t.id === handle) {
                    t.canceled = true
                }
            }
        },
    }

    const processTreeReader: ProcessTreeReader = {
        getProcessTree: async (root) => treeByRoot.get(root) ?? [],
    }

    const processFinder: ProcessFinder = {
        findProcessIdByCommandLineMarker: async (marker) => {
            markerQueries.push(marker)
            return opts?.pidByMarker ?? null
        },
    }

    const notifier = {
        showError: (message: string) => {
            warnings.push(message)
        },
        showWarning: (message: string) => {
            warnings.push(message)
        },
    }

    const session = {
        configuration: {
            ...(opts?.sessionConfig ? { [SECRET_RESOLVER_CONFIG_FIELD]: opts.sessionConfig } : {}),
        },
    } as unknown as vscode.DebugSession
    const tracker = new SecretDebugAdapterTrackerFactory(registry, {
        processController,
        processTreeReader,
        processFinder,
        notifier,
    }).createDebugAdapterTracker(session) as
        | vscode.DebugAdapterTracker
        | undefined

    const fireTimer = (idx: number) => {
        const t = timers[idx]

        if (t && !t.canceled) {
            t.cb()
        }
    }

    return { tracker, kills, timers, treeByRoot, warnings, markerQueries, fireTimer }
}

function makeTracker(
    registry: TempDirRegistry = new InMemoryTempDirRegistry(),
    configuration: Record<string, unknown> = {},
): vscode.DebugAdapterTracker | undefined {
    return new SecretDebugAdapterTrackerFactory(registry)
        .createDebugAdapterTracker({
            configuration,
        } as unknown as vscode.DebugSession) as
            | vscode.DebugAdapterTracker
            | undefined
}

function makeResponse(
    body: { processId?: number; shellProcessId?: number },
): DebugProtocol.RunInTerminalResponse {
    return {
        seq: 2,
        type: "response",
        request_seq: 1,
        success: true,
        command: "runInTerminal",
        body,
    }
}

function makeDisconnectRequest(
    args?: { terminateDebuggee?: boolean },
): DebugProtocol.DisconnectRequest {
    return {
        seq: 3,
        type: "request",
        command: "disconnect",
        arguments: args,
    }
}

function makeExitedEvent(): DebugProtocol.ExitedEvent {
    return {
        seq: 4,
        type: "event",
        event: "exited",
        body: { exitCode: 0 },
    }
}

/**
 * Flushes the microtask queue (and one event-loop tick) so async work
 * kicked off by a sync DAP hook — e.g. `signalProcessTree` after a
 * `disconnect` request — has a chance to run before assertions.
 */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Builds the standard wrapping topology as a flat PID list: shell → op run →
 * program(s). This is what `getProcessTree(shellPid)` returns (the root PID
 * first, then descendants); the controller signals every PID except the
 * captured root.
 */
function makeWrappedTree(opts: {
    shellPid: number
    opPid: number
    childPids: number[]
}): number[] {
    return [opts.shellPid, opts.opPid, ...opts.childPids]
}

function makeRequest(
    args: string[],
    env: Record<string, string | null> = {},
): DebugProtocol.RunInTerminalRequest {
    return {
        seq: 1,
        type: "request",
        command: "runInTerminal",
        arguments: {
            kind: "integrated",
            title: "Secret Resolver",
            cwd: os.tmpdir(),
            args,
            env,
        },
    }
}

function configuredOpPath(): string {
    return vscode.workspace
        .getConfiguration("secretResolver")
        .get<string>("opPath", "op")
}

function readEnvFileFromArgs(args: readonly string[]): {
    envFilePath: string
    parsed: Record<string, string>
} {
    const flag = args.find((a) => a.startsWith("--env-file="))
    assert.ok(flag, "expected --env-file= argument")
    const envFilePath = flag.slice("--env-file=".length)
    // The dotenv writer escapes special chars but the reader only strips
    // outer quotes. Tests pick values that round-trip cleanly through both.
    return { envFilePath, parsed: readDotenvSync(envFilePath) }
}

function readDotenvSync(filePath: string): Record<string, string> {
    const out: Record<string, string> = {}
    const text = fs.readFileSync(filePath, "utf8")

    for (const rawLine of text.split(/\r?\n/)) {
        if (rawLine.length === 0) {
            continue
        }

        const eq = rawLine.indexOf("=")
        const key = rawLine.slice(0, eq)
        let value = rawLine.slice(eq + 1)

        if (
            value.length >= 2
            && value.startsWith("\"")
            && value.endsWith("\"")
        ) {
            value = value.slice(1, -1)
        }

        out[key] = value
    }

    return out
}

suite("runtime integration", () => {
    test("wraps env in op run --env-file when env has op:// refs", async () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        })

        tracker?.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.strictEqual(args[0], configuredOpPath())
        assert.strictEqual(args[1], "run")
        assert.ok(args[2].startsWith("--env-file="))
        assert.strictEqual(args[3], "--")
        assert.deepStrictEqual(args.slice(4), ["node", "app.js"])

        assert.deepStrictEqual(message.arguments.env, {})

        const { envFilePath, parsed } = readEnvFileFromArgs(args)
        assert.deepStrictEqual(parsed, {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        })

        const stat = fs.statSync(envFilePath)
        assert.strictEqual(stat.mode & 0o777, 0o600)
        const dirStat = fs.statSync(path.dirname(envFilePath))
        assert.strictEqual(dirStat.mode & 0o777, 0o700)

        // cleanup so the registry sweep doesn't leave residue.
        registry.cleanup()
        assert.ok(!fs.existsSync(envFilePath))
    })

    test("wraps env in op run --env-file when env has plaintext (cache mode)", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)

        const message = makeRequest(["node", "app.js"], {
            DB_URL: "postgres://example",
            LOG_LEVEL: "info",
        })

        tracker?.onDidSendMessage?.(message)

        const { envFilePath, parsed } = readEnvFileFromArgs(message.arguments.args)
        assert.deepStrictEqual(parsed, {
            DB_URL: "postgres://example",
            LOG_LEVEL: "info",
        })
        assert.ok(!Object.values(parsed).some((v) => v.startsWith("op://")))

        registry.cleanup()
        assert.ok(!fs.existsSync(envFilePath))
    })

    test("wraps any terminal launch with non-empty env (no op:// refs needed)", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)

        const message = makeRequest(["node", "app.js"], {
            FOO: "bar",
        })

        tracker?.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.strictEqual(args[0], configuredOpPath())
        assert.strictEqual(args[1], "run")
        assert.ok(args[2].startsWith("--env-file="))

        registry.cleanup()
    })

    test("no-op when env is missing", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)

        const message: DebugProtocol.RunInTerminalRequest = {
            seq: 1,
            type: "request",
            command: "runInTerminal",
            arguments: {
                kind: "integrated",
                title: "Secret Resolver",
                cwd: os.tmpdir(),
                args: ["node", "app.js"],
                // env intentionally omitted
            } as DebugProtocol.RunInTerminalRequestArguments,
        }
        const argsBefore = [...message.arguments.args]

        tracker?.onDidSendMessage?.(message)

        assert.deepStrictEqual(message.arguments.args, argsBefore)
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("no-op when env is empty", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        const message = makeRequest(["node", "app.js"], {})
        const argsBefore = [...message.arguments.args]

        tracker?.onDidSendMessage?.(message)

        assert.deepStrictEqual(message.arguments.args, argsBefore)
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("no-op when env has only null values and no launch env", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        const message = makeRequest(["node", "app.js"], { FOO: null, BAR: null })
        const argsBefore = [...message.arguments.args]

        tracker?.onDidSendMessage?.(message)

        assert.deepStrictEqual(message.arguments.args, argsBefore)
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("moves launch env vars into the env file even when the adapter does not forward them", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry, {
            env: { FROM_LAUNCH: "yes", SHARED: "launch-value" },
        })
        const message = makeRequest(["node", "app.js"], {
            DAP_ONLY: "1",
            SHARED: "adapter-value",
        })

        tracker?.onDidSendMessage?.(message)

        const { parsed } = readEnvFileFromArgs(message.arguments.args)
        assert.deepStrictEqual(parsed, {
            FROM_LAUNCH: "yes",
            SHARED: "adapter-value",
            DAP_ONLY: "1",
        })
        assert.deepStrictEqual(message.arguments.env, {})

        registry.cleanup()
    })

    test("wraps using only the launch env when the request env is empty", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry, {
            env: { FROM_LAUNCH: "yes" },
        })
        const message = makeRequest(["node", "app.js"], {})

        tracker?.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.strictEqual(args[0], configuredOpPath())
        assert.strictEqual(args[1], "run")

        const { parsed } = readEnvFileFromArgs(args)
        assert.deepStrictEqual(parsed, { FROM_LAUNCH: "yes" })

        registry.cleanup()
    })

    test("null request env entries unset launch env vars", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry, {
            env: { DROP_ME: "x", KEEP: "y" },
        })
        const message = makeRequest(["node", "app.js"], { DROP_ME: null })

        tracker?.onDidSendMessage?.(message)

        const { parsed } = readEnvFileFromArgs(message.arguments.args)
        assert.deepStrictEqual(parsed, { KEEP: "y" })

        registry.cleanup()
    })

    test("ignores non-runInTerminal messages", () => {
        if (process.platform === "win32") {
            return
        }

        const tracker = makeTracker()
        const message = {
            seq: 2,
            type: "event",
            event: "stopped",
        } as unknown as DebugProtocol.RunInTerminalRequest
        const before = JSON.stringify(message)

        tracker?.onDidSendMessage?.(message)

        assert.strictEqual(JSON.stringify(message), before)
    })

    test("ignores malformed runInTerminal payloads", () => {
        if (process.platform === "win32") {
            return
        }

        const tracker = makeTracker()
        const message = {
            seq: 3,
            type: "request",
            command: "runInTerminal",
            arguments: {},
        } as unknown as DebugProtocol.RunInTerminalRequest

        tracker?.onDidSendMessage?.(message)

        assert.deepStrictEqual(message.arguments, {})
    })

    test("removes the temp dir on onWillStopSession", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry) as
            | (vscode.DebugAdapterTracker & {
                onWillStopSession?: () => void
            })
            | undefined
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], { FOO: "bar" })
        tracker.onDidSendMessage?.(message)
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args)
        assert.ok(fs.existsSync(envFilePath))

        tracker.onWillStopSession?.()

        assert.ok(!fs.existsSync(envFilePath))
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("removes the temp dir on onExit", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry) as
            | (vscode.DebugAdapterTracker & {
                onExit?: (code?: number, signal?: string) => void
            })
            | undefined
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], { FOO: "bar" })
        tracker.onDidSendMessage?.(message)
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args)
        assert.ok(fs.existsSync(envFilePath))

        tracker.onExit?.(0, undefined)

        assert.ok(!fs.existsSync(envFilePath))
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("registry.cleanup() removes any leftover dirs", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)

        const message = makeRequest(["node", "app.js"], { FOO: "bar" })
        tracker?.onDidSendMessage?.(message)
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args)
        const dir = path.dirname(envFilePath)
        assert.ok(fs.existsSync(dir))

        registry.cleanup()

        assert.ok(!fs.existsSync(dir))
        assert.strictEqual(registry.snapshot().length, 0)
    })

    test("activation-time sweep removes dirs whose owning PID is gone", () => {
        if (process.platform === "win32") {
            return
        }

        const root = os.tmpdir()
        const stale = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX))
        const deadPid = pickDeadPid()
        fs.writeFileSync(path.join(stale, ".pid"), String(deadPid), {
            mode: 0o600,
        })
        fs.writeFileSync(path.join(stale, "env"), "FOO=bar\n", { mode: 0o600 })

        InMemoryTempDirRegistry.sweepStale()

        assert.ok(!fs.existsSync(stale))
    })

    test("activation-time sweep leaves alive-PID dirs alone", () => {
        if (process.platform === "win32") {
            return
        }

        const root = os.tmpdir()
        const live = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX))
        fs.writeFileSync(path.join(live, ".pid"), String(process.pid), {
            mode: 0o600,
        })
        fs.writeFileSync(path.join(live, "env"), "FOO=bar\n", { mode: 0o600 })

        try {
            InMemoryTempDirRegistry.sweepStale()
            assert.ok(fs.existsSync(live))
        }
        finally {
            fs.rmSync(live, { recursive: true, force: true })
        }
    })

    test("activation-time sweep leaves dirs without .pid alone", () => {
        if (process.platform === "win32") {
            return
        }

        const root = os.tmpdir()
        const orphan = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX))
        fs.writeFileSync(path.join(orphan, "env"), "FOO=bar\n", {
            mode: 0o600,
        })

        try {
            InMemoryTempDirRegistry.sweepStale()
            assert.ok(fs.existsSync(orphan))
        }
        finally {
            fs.rmSync(orphan, { recursive: true, force: true })
        }
    })

    test("DotenvFile.format output is parseable by DotenvFile.parseFile for safe values", async () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        const message = makeRequest(["node", "app.js"], {
            URL: "https://example.com/path",
            REF: "op://vault/item/url",
        })

        tracker?.onDidSendMessage?.(message)

        const { envFilePath } = readEnvFileFromArgs(message.arguments.args)
        const parsed = await new DotenvFile(envFilePath).parseFile()
        assert.deepStrictEqual(parsed, {
            URL: "https://example.com/path",
            REF: "op://vault/item/url",
        })

        registry.cleanup()
    })

    test("signal-on-stop: sends SIGTERM to descendants on disconnect", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, timers } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })
        assert.ok(tracker)

        tracker.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
        assert.strictEqual(timers.length, 0)
    })

    test("signal-on-stop: signals every descendant of the captured root, not just op's direct children", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            treeByRoot: new Map([[
                4242,
                // shell(root) → op run → program → grandchild. Every PID
                // except the root itself is signaled.
                [4242, 8000, 9000, 9100],
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
            { pid: 9100, signal: "SIGTERM" },
        ])
    })

    test("signal-on-stop: prefers shellProcessId (the runInTerminal shell) over processId", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "KILL" }] },
            treeByRoot: new Map([
                [
                    4242,
                    makeWrappedTree({
                        shellPid: 4242,
                        opPid: 8000,
                        childPids: [9000],
                    }),
                ],
                [
                    555,
                    makeWrappedTree({
                        shellPid: 555,
                        opPid: 7000,
                        childPids: [9999],
                    }),
                ],
            ]),
        })

        tracker?.onWillReceiveMessage?.(
            makeResponse({ processId: 555, shellProcessId: 4242 }),
        )
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        // Walked from shellProcessId (4242), so its subtree (8000, 9000) —
        // not 555's subtree (7000, 9999) — is signaled.
        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGKILL" },
            { pid: 9000, signal: "SIGKILL" },
        ])
    })

    test("signal-on-stop: falls back to processId when shellProcessId is absent", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "KILL" }] },
            treeByRoot: new Map([[
                555,
                // The root we capture is `op run` itself (555); it has the
                // program (9000) as its child. The root is excluded, so only
                // 9000 is signaled.
                [555, 9000],
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ processId: 555 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGKILL" }])
    })

    test("signal-on-stop: signals descendants regardless of the wrapper (op or otherwise)", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            treeByRoot: new Map([[
                4242,
                // No `op run` wrapper in the tree — the program is a direct
                // child of the shell. It is still signaled.
                [4242, 9000],
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
    })

    test("signal-on-stop: warns and skips when the root has no descendants", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            // Only the root remains alive (program already gone).
            treeByRoot: new Map([[4242, [4242]]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: detach (terminateDebuggee=false) does not signal", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: false }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: omitted terminateDebuggee defaults to terminate", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(makeDisconnectRequest())

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
    })

    test("signal-on-stop: term+kill schedules SIGKILL after the grace period", async () => {
        if (process.platform === "win32") {
            return
        }

        const tree = makeWrappedTree({
            shellPid: 4242,
            opPid: 8000,
            childPids: [9000],
        })
        const { tracker, kills, timers, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            treeByRoot: new Map([[4242, tree]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
        assert.strictEqual(timers.length, 1)
        assert.strictEqual(timers[0].ms, 5000)

        fireTimer(0)
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
            { pid: 8000, signal: "SIGKILL" },
            { pid: 9000, signal: "SIGKILL" },
        ])
    })

    test("signal-on-stop: term+kill re-walks the tree at SIGKILL time", async () => {
        if (process.platform === "win32") {
            return
        }

        const treeByRoot = new Map<number, number[]>([[
            4242,
            makeWrappedTree({
                shellPid: 4242,
                opPid: 8000,
                childPids: [9000],
            }),
        ]])
        const { tracker, kills, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            treeByRoot,
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )
        await flush()
        // Between SIGTERM and the grace timer firing, op run forks a helper.
        treeByRoot.set(
            4242,
            makeWrappedTree({
                shellPid: 4242,
                opPid: 8000,
                childPids: [9000, 9001],
            }),
        )
        fireTimer(0)
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
            { pid: 8000, signal: "SIGKILL" },
            { pid: 9000, signal: "SIGKILL" },
            { pid: 9001, signal: "SIGKILL" },
        ])
    })

    test("signal-on-stop: exited event before disconnect cancels the signal", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onDidSendMessage?.(makeExitedEvent())
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: exited event during grace period cancels SIGKILL", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, timers, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )
        await flush()
        // Program exits naturally before grace period elapses.
        tracker?.onDidSendMessage?.(makeExitedEvent())

        assert.strictEqual(timers[0].canceled, true)
        fireTimer(0) // No-op because canceled.
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
    })

    test("signal-on-stop: no signal when session config is absent", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            // sessionConfig intentionally omitted -> "off" / feature disabled
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: no terminal launch observed -> no signal, no warning", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, warnings } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            pidByMarker: 4242,
        })

        // No runInTerminal request or response observed (e.g. internalConsole);
        // only a disconnect arrives.
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(warnings, [])

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: ESRCH from kill is swallowed silently", async () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const kills: KillCall[] = []

        const processController: ProcessController = {
            kill: (pid, signal) => {
                kills.push({ pid, signal })
                const err = new Error("no such process") as NodeJS.ErrnoException
                err.code = "ESRCH"
                throw err
            },
            setTimer: setTimeout,
            clearTimer: clearTimeout,
        }

        const processTreeReader: ProcessTreeReader = {
            getProcessTree: async (root) => root === 4242 ? [4242, 8000, 9000] : [],
        }

        const session = {
            configuration: {
                [SECRET_RESOLVER_CONFIG_FIELD]: {
                    steps: [{ delaySec: 0, signal: "TERM" }],
                } as SecretResolverSessionConfig,
            },
        } as unknown as vscode.DebugSession
        const tracker = new SecretDebugAdapterTrackerFactory(registry, {
            processController,
            processTreeReader,
        })
            .createDebugAdapterTracker(session) as
                | vscode.DebugAdapterTracker
                | undefined

        // Should not throw even though the kill stub raises ESRCH.
        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
    })

    test("signal-on-stop: falls back to marker lookup when the terminal reports no PID", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, warnings, markerQueries } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            pidByMarker: 4242,
            treeByRoot: new Map([[4242, [4242, 8000, 9000]]]),
        })

        // The rewrite creates the per-launch temp dir whose basename is the marker.
        const request = makeRequest(["node", "app.js"], { FOO: "bar" })
        tracker?.onDidSendMessage?.(request)

        // External terminals: the runInTerminal response has no PID fields.
        tracker?.onWillReceiveMessage?.(makeResponse({}))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.strictEqual(markerQueries.length, 1)
        assert.match(markerQueries[0], /^secret-resolver-/)
        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
        assert.deepStrictEqual(warnings, [])

        const trackerWithStop = tracker as vscode.DebugAdapterTracker & {
            onWillStopSession?: () => void
        }
        trackerWithStop.onWillStopSession?.()
    })

    test("signal-on-stop: warns when the marker lookup finds no process", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, warnings } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            pidByMarker: null,
        })

        const request = makeRequest(["node", "app.js"], { FOO: "bar" })
        tracker?.onDidSendMessage?.(request)

        tracker?.onWillReceiveMessage?.(makeResponse({}))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /no process matching/)

        const trackerWithStop = tracker as vscode.DebugAdapterTracker & {
            onWillStopSession?: () => void
        }
        trackerWithStop.onWillStopSession?.()
    })

    test("signal-on-stop: warns when the terminal reports no PID and no rewrite happened", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, warnings, markerQueries } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            pidByMarker: 4242,
        })

        // No runInTerminal request → no env rewrite → no marker.
        tracker?.onWillReceiveMessage?.(makeResponse({}))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
        assert.deepStrictEqual(markerQueries, [])
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /no launch marker/)
    })

    test("signal-on-stop: onWillStopSession does not cancel pending kill timer", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, timers } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )
        await flush()
        assert.strictEqual(timers[0].canceled, false)
        ;(
            tracker as
                | (vscode.DebugAdapterTracker & {
                    onWillStopSession?: () => void
                })
                | undefined
        )?.onWillStopSession?.()

        // Timer must survive session stop so multi-step sequences can complete.
        assert.strictEqual(timers[0].canceled, false)

        tracker?.onExit?.(0, undefined)

        assert.strictEqual(timers[0].canceled, true)
    })

    test("signal-on-stop: SIGINT is forwarded correctly", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "INT" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGINT" },
            { pid: 9000, signal: "SIGINT" },
        ])
    })

    test("signal-on-stop: SIGHUP is forwarded correctly", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "HUP" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGHUP" },
            { pid: 9000, signal: "SIGHUP" },
        ])
    })

    test("wraps env once in op run --env-file (no token.env double-wrap)", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], { DB: "op://v/i/db" })
        tracker!.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.strictEqual(args[0], configuredOpPath())
        assert.strictEqual(args[1], "run")
        assert.ok(args[2].startsWith("--env-file=") && !args[2].endsWith("token.env"))
        assert.strictEqual(args[3], "--")
        assert.deepStrictEqual(args.slice(4), ["node", "app.js"])

        assert.deepStrictEqual(message.arguments.env, {})
        registry.cleanup()
    })

    test("account-id: single-wrap passes --account when accountId is set", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const { tracker } = makeTrackerWithStubs({
            registry,
            sessionConfig: { steps: [], accountId: "SOME_ACCOUNT_ID" },
        })
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], { DB: "op://v/i/db" })
        tracker!.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.strictEqual(args[0], configuredOpPath())
        assert.strictEqual(args[1], "run")
        assert.strictEqual(args[2], "--account")
        assert.strictEqual(args[3], "SOME_ACCOUNT_ID")
        assert.ok(args[4].startsWith("--env-file="), `expected --env-file= at index 4, got ${args[4]}`)
        assert.strictEqual(args[5], "--")
        assert.deepStrictEqual(args.slice(6), ["node", "app.js"])

        const envFilePath = args[4].slice("--env-file=".length)
        const env = readDotenvSync(envFilePath)
        assert.strictEqual(env["DB"], "op://v/i/db")

        registry.cleanup()
    })

    test("account-id: no --account flag when accountId is absent", () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const tracker = makeTracker(registry)
        assert.ok(tracker)

        const message = makeRequest(["node", "app.js"], { DB: "op://v/i/db" })
        tracker!.onDidSendMessage?.(message)

        const args = message.arguments.args
        assert.ok(!args.includes("--account"), "no --account flag")

        registry.cleanup()
    })

    test("signal-on-stop: leading delaySec fires timer before first signal", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, timers, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 10, signal: "TERM" }] },
            treeByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    childPids: [9000],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        // Signal not sent yet — waiting for the leading delay timer.
        assert.deepStrictEqual(kills, [])
        assert.strictEqual(timers.length, 1)
        assert.strictEqual(timers[0].ms, 10_000)

        fireTimer(0)
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 8000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGTERM" },
        ])
    })
})

function pickDeadPid(): number {
    // PIDs are recycled; find one that is currently not alive. Start high
    // and walk down. Caller is responsible for the slim race that the kernel
    // hands this PID to a fresh process between the check and the sweep.
    for (let candidate = 999999; candidate > 1000; candidate -= 7919) {
        try {
            process.kill(candidate, 0)
        }
        catch (err) {
            const code = (err as NodeJS.ErrnoException).code

            if (code === "ESRCH") {
                return candidate
            }
        }
    }

    throw new Error("could not find a dead pid")
}
