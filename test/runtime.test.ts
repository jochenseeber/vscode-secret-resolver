import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import * as vscode from "vscode"

import { DebugProtocol } from "@vscode/debugprotocol"
import {
    type GetProcessTreeFn,
    type KillFn,
    type ProcessInfo,
    SecretDebugAdapterTrackerFactory,
    type TempDirRegistry,
} from "../src/debugAdapterProxy"
import { parseEnvFile } from "../src/dotenv"
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "../src/resolveLaunchConfig"
import { cleanupRegistry, InMemoryTempDirRegistry, sweepStaleTempDirs, TEMP_DIR_PREFIX } from "../src/tempDirRegistry"

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
    descendantsByRoot?: Map<number, ProcessInfo[]>
}): {
    tracker: vscode.DebugAdapterTracker | undefined
    kills: KillCall[]
    timers: ScheduledTimer[]
    descendantsByRoot: Map<number, ProcessInfo[]>
    fireTimer: (idx: number) => void
} {
    const registry = opts?.registry ?? new InMemoryTempDirRegistry()
    const kills: KillCall[] = []
    const timers: ScheduledTimer[] = []
    const descendantsByRoot = opts?.descendantsByRoot ?? new Map()

    const kill: KillFn = (pid, signal) => {
        kills.push({ pid, signal })
    }

    const setKillTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
        const id = {} as NodeJS.Timeout
        timers.push({ id, cb, ms, canceled: false })
        return id
    }

    const clearKillTimer = (handle: NodeJS.Timeout) => {
        for (const t of timers) {
            if (t.id === handle) {
                t.canceled = true
            }
        }
    }

    const getDescendants: GetProcessTreeFn = async (root) => descendantsByRoot.get(root) ?? []

    const session = {
        configuration: opts?.sessionConfig
            ? { [SECRET_RESOLVER_CONFIG_FIELD]: opts.sessionConfig }
            : {},
    } as unknown as vscode.DebugSession
    const tracker = new SecretDebugAdapterTrackerFactory(
        registry,
        kill,
        setKillTimer,
        clearKillTimer,
        getDescendants,
    ).createDebugAdapterTracker(session) as
        | vscode.DebugAdapterTracker
        | undefined

    const fireTimer = (idx: number) => {
        const t = timers[idx]

        if (t && !t.canceled) {
            t.cb()
        }
    }

    return { tracker, kills, timers, descendantsByRoot, fireTimer }
}

function makeTracker(
    registry: TempDirRegistry = new InMemoryTempDirRegistry(),
): vscode.DebugAdapterTracker | undefined {
    return new SecretDebugAdapterTrackerFactory(registry)
        .createDebugAdapterTracker({
            configuration: {},
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
 * Builds the standard wrapping topology: shell → op run → program(s).
 * The tree is what `getProcessTree(shellPid)` returns; the tracker walks
 * it, finds the `op run` wrapper, and signals its direct children.
 */
function makeWrappedTree(opts: {
    shellPid: number
    opPid: number
    children: { pid: number; command: string }[]
    shellCommand?: string
    opCommand?: string
}): ProcessInfo[] {
    const tree: ProcessInfo[] = [
        {
            pid: opts.shellPid,
            ppid: 1,
            command: opts.shellCommand ?? "/bin/bash",
        },
        {
            pid: opts.opPid,
            ppid: opts.shellPid,
            command: opts.opCommand
                ?? "/opt/homebrew/bin/op run --env-file=/tmp/x -- java TestJavaLaunch",
        },
    ]

    for (const child of opts.children) {
        tree.push({ pid: child.pid, ppid: opts.opPid, command: child.command })
    }

    return tree
}

function makeRequest(
    args: string[],
    env: Record<string, string> = {},
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
    // The dotenv writer escapes special chars but parseEnvFile only strips
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
    test("wraps env in op run --env-file when env has op:// refs (op-run mode)", async () => {
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
        cleanupRegistry(registry)
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

        cleanupRegistry(registry)
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

        cleanupRegistry(registry)
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

    test("cleanupRegistry removes any leftover dirs", () => {
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

        cleanupRegistry(registry)

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

        sweepStaleTempDirs()

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
            sweepStaleTempDirs()
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
            sweepStaleTempDirs()
            assert.ok(fs.existsSync(orphan))
        }
        finally {
            fs.rmSync(orphan, { recursive: true, force: true })
        }
    })

    test("formatDotenv output is parseable by parseEnvFile for safe values", async () => {
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
        const parsed = await parseEnvFile(envFilePath)
        assert.deepStrictEqual(parsed, {
            URL: "https://example.com/path",
            REF: "op://vault/item/url",
        })

        cleanupRegistry(registry)
    })

    test("signal-on-stop: sends SIGTERM to descendants on disconnect", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, timers } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "java TestJavaLaunch" }],
                }),
            ]]),
        })
        assert.ok(tracker)

        tracker.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
        assert.strictEqual(timers.length, 0)
    })

    test("signal-on-stop: signals only direct children of the op run wrapper", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            descendantsByRoot: new Map([[
                4242,
                [
                    // Shell at the root (skipped: not a child of op run).
                    { pid: 4242, ppid: 1, command: "/bin/bash" },
                    // op run wrapper itself (skipped: it's the parent we
                    // walk *from*, not a target).
                    {
                        pid: 8000,
                        ppid: 4242,
                        command: "/opt/homebrew/bin/op run -- java",
                    },
                    // Direct child of op run — this is the target.
                    {
                        pid: 9000,
                        ppid: 8000,
                        command: "java TestJavaLaunch",
                    },
                    // A grandchild of op run — NOT a direct child, so not
                    // signaled.
                    { pid: 9100, ppid: 9000, command: "java helper" },
                ],
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
    })

    test("signal-on-stop: prefers shellProcessId (the runInTerminal shell) over processId", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "KILL" }] },
            descendantsByRoot: new Map([
                [
                    4242,
                    makeWrappedTree({
                        shellPid: 4242,
                        opPid: 8000,
                        children: [{ pid: 9000, command: "java" }],
                    }),
                ],
                [
                    555,
                    makeWrappedTree({
                        shellPid: 555,
                        opPid: 7000,
                        children: [{ pid: 9999, command: "java" }],
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

        // Walked from shellProcessId (4242), so 9000 — not 9999 — is signaled.
        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGKILL" }])
    })

    test("signal-on-stop: falls back to processId when shellProcessId is absent", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "KILL" }] },
            descendantsByRoot: new Map([[
                555,
                // The root we capture is `op run` itself; it has the program
                // as its direct child. The shell is not in the walked tree.
                [
                    {
                        pid: 555,
                        ppid: 4242,
                        command: "/opt/homebrew/bin/op run -- java",
                    },
                    { pid: 9000, ppid: 555, command: "java" },
                ],
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ processId: 555 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGKILL" }])
    })

    test("signal-on-stop: warns and skips when no op run wrapper is in the tree", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
            descendantsByRoot: new Map([[
                4242,
                [
                    { pid: 4242, ppid: 1, command: "/bin/bash" },
                    { pid: 9000, ppid: 4242, command: "java" },
                ],
            ]]),
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
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "java" }],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(makeDisconnectRequest())

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
    })

    test("signal-on-stop: term+kill schedules SIGKILL after the grace period", async () => {
        if (process.platform === "win32") {
            return
        }

        const tree = makeWrappedTree({
            shellPid: 4242,
            opPid: 8000,
            children: [{ pid: 9000, command: "java" }],
        })
        const { tracker, kills, timers, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            descendantsByRoot: new Map([[4242, tree]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
        assert.strictEqual(timers.length, 1)
        assert.strictEqual(timers[0].ms, 5000)

        fireTimer(0)
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 9000, signal: "SIGTERM" },
            { pid: 9000, signal: "SIGKILL" },
        ])
    })

    test("signal-on-stop: term+kill re-walks the tree at SIGKILL time", async () => {
        if (process.platform === "win32") {
            return
        }

        const descendantsByRoot = new Map<number, ProcessInfo[]>([[
            4242,
            makeWrappedTree({
                shellPid: 4242,
                opPid: 8000,
                children: [{ pid: 9000, command: "java" }],
            }),
        ]])
        const { tracker, kills, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            descendantsByRoot,
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )
        await flush()
        // Between SIGTERM and the grace timer firing, op run forks a helper.
        descendantsByRoot.set(
            4242,
            makeWrappedTree({
                shellPid: 4242,
                opPid: 8000,
                children: [
                    { pid: 9000, command: "java" },
                    { pid: 9001, command: "java forked-helper" },
                ],
            }),
        )
        fireTimer(0)
        await flush()

        assert.deepStrictEqual(kills, [
            { pid: 9000, signal: "SIGTERM" },
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
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "java" }],
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

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
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

    test("signal-on-stop: no PID captured -> no signal", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }] },
        })

        // No runInTerminal response observed; only a disconnect arrives.
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [])
    })

    test("signal-on-stop: ESRCH from kill is swallowed silently", async () => {
        if (process.platform === "win32") {
            return
        }

        const registry = new InMemoryTempDirRegistry()
        const kills: KillCall[] = []

        const kill: KillFn = (pid, signal) => {
            kills.push({ pid, signal })
            const err = new Error("no such process") as NodeJS.ErrnoException
            err.code = "ESRCH"
            throw err
        }

        const getDescendants: GetProcessTreeFn = async (root) =>
            root === 4242
                ? [
                    { pid: 4242, ppid: 1, command: "/bin/bash" },
                    { pid: 8000, ppid: 4242, command: "op run -- java" },
                    { pid: 9000, ppid: 8000, command: "java" },
                ]
                : []

        const session = {
            configuration: {
                [SECRET_RESOLVER_CONFIG_FIELD]: {
                    steps: [{ delaySec: 0, signal: "TERM" }],
                } as SecretResolverSessionConfig,
            },
        } as unknown as vscode.DebugSession
        const tracker = new SecretDebugAdapterTrackerFactory(
            registry,
            kill,
            setTimeout,
            clearTimeout,
            getDescendants,
        )
            .createDebugAdapterTracker(session) as
                | vscode.DebugAdapterTracker
                | undefined

        // Should not throw even though the kill stub raises ESRCH.
        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
    })

    test("signal-on-stop: onWillStopSession does not cancel pending kill timer", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, timers } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "TERM" }, { delaySec: 5, signal: "KILL" }] },
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "java" }],
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
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "node app.js" }],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGINT" }])
    })

    test("signal-on-stop: SIGHUP is forwarded correctly", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 0, signal: "HUP" }] },
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "node app.js" }],
                }),
            ]]),
        })

        tracker?.onWillReceiveMessage?.(makeResponse({ shellProcessId: 4242 }))
        tracker?.onWillReceiveMessage?.(
            makeDisconnectRequest({ terminateDebuggee: true }),
        )

        await flush()

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGHUP" }])
    })

    test("token-tag: single-wraps (no token.env) when tokenTag is absent", () => {
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
        assert.ok(args[2].startsWith("--env-file="))
        assert.strictEqual(args[3], "--")
        assert.deepStrictEqual(args.slice(4), ["node", "app.js"])

        assert.deepStrictEqual(message.arguments.env, {})
        cleanupRegistry(registry)
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

        cleanupRegistry(registry)
    })

    test("signal-on-stop: leading delaySec fires timer before first signal", async () => {
        if (process.platform === "win32") {
            return
        }

        const { tracker, kills, timers, fireTimer } = makeTrackerWithStubs({
            sessionConfig: { steps: [{ delaySec: 10, signal: "TERM" }] },
            descendantsByRoot: new Map([[
                4242,
                makeWrappedTree({
                    shellPid: 4242,
                    opPid: 8000,
                    children: [{ pid: 9000, command: "java" }],
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

        assert.deepStrictEqual(kills, [{ pid: 9000, signal: "SIGTERM" }])
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
