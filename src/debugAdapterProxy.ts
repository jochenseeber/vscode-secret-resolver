import * as fs from "node:fs"

import * as vscode from "vscode"

import { isRunInTerminalRequest } from "./launchRewrite"
import { OpRunner } from "./opRunner"
import { createDefaultGetProcessTree, type GetProcessTreeFn, type PsRunner } from "./processTree"
import { RunInTerminalEnvRewriter, type ServiceAccountTokenProvider } from "./runInTerminalEnvRewriter"
import { parseSessionConfig, type SecretResolverSessionConfig } from "./sessionConfig"
import { type KillFn, StopSignalController } from "./stopSignalController"

// Re-exports kept for the integration tests + any future external consumers.
export { type GetProcessTreeFn, isOpRunCommand, type ProcessInfo } from "./processTree"
export { type KillFn } from "./stopSignalController"

/**
 * Master registry of temp dirs the trackers have created. Owned by
 * `extension.ts`; the registry survives across debug sessions and lets the
 * extension drive cleanup from `deactivate`, signal handlers, and the
 * activation-time stale-dir sweep.
 */
export interface TempDirRegistry {
    add(dir: string): void
    remove(dir: string): void
}

/**
 * Per-session tracker. For every `runInTerminal` request whose env has at
 * least one non-null entry, the tracker writes the env to a `0600` dotenv
 * file inside a `0700` temp dir under `os.tmpdir()`, swaps `arguments.args`
 * to invoke `op run --env-file=<path> -- <orig args>`, and clears
 * `arguments.env`. Cleanup runs on `onWillStopSession` and `onExit`.
 *
 * When the session config carries a `__secretResolver` block, the tracker also
 * captures the spawned PID from the `runInTerminal` response, watches for the
 * user's Stop request via the DAP `disconnect` request, and signals the
 * program. Detach (`terminateDebuggee === false`) is a no-op.
 *
 * Caveat: VS Code's tracker API is documented as observation-only. The
 * mutations of `arguments.args` and `arguments.env` rely on messages being
 * passed by reference and dispatched after the hook returns — the practical
 * reality for years, but not a formal guarantee.
 */
class SecretDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private readonly dirs: string[] = []
    private readonly envRewriter: RunInTerminalEnvRewriter
    private readonly stopSignals: StopSignalController

    constructor(
        private readonly registry: TempDirRegistry,
        private readonly sessionConfig: SecretResolverSessionConfig | undefined,
        private readonly runner: OpRunner,
        kill: KillFn,
        setKillTimer: (
            cb: () => void,
            ms: number,
        ) => NodeJS.Timeout,
        clearKillTimer: (handle: NodeJS.Timeout) => void,
        getProcessTree: GetProcessTreeFn,
        getServiceAccountToken: ServiceAccountTokenProvider,
    ) {
        this.envRewriter = new RunInTerminalEnvRewriter(getServiceAccountToken)
        this.stopSignals = new StopSignalController(
            sessionConfig,
            kill,
            setKillTimer,
            clearKillTimer,
            getProcessTree,
        )
    }

    onDidSendMessage(message: unknown): void {
        this.stopSignals.onDidSendMessage(message)

        if (!isRunInTerminalRequest(message)) {
            return
        }

        const dir = this.envRewriter.rewrite(message, this.runner, this.sessionConfig)

        if (dir !== undefined) {
            this.dirs.push(dir)
            this.registry.add(dir)
        }
    }

    onWillReceiveMessage(message: unknown): void {
        this.stopSignals.onWillReceiveMessage(message)
    }

    onWillStopSession(): void {
        this.cleanup()
    }

    onExit(): void {
        this.stopSignals.onExit()
        this.cleanup()
    }

    private cleanup(): void {
        while (this.dirs.length > 0) {
            const dir = this.dirs.pop()!

            try {
                fs.rmSync(dir, { recursive: true, force: true })
            }
            catch {
                // best-effort
            }

            this.registry.remove(dir)
        }
    }
}

export interface TrackerFactoryOptions {
    kill?: KillFn
    setKillTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
    clearKillTimer?: (handle: NodeJS.Timeout) => void
    psRunner?: PsRunner
    /** Override the process-tree reader. Takes precedence over `psRunner`. */
    getProcessTree?: GetProcessTreeFn
    getServiceAccountToken?: (tag: string) => string | undefined
}

export class SecretDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(
        private readonly registry: TempDirRegistry,
        private readonly options: TrackerFactoryOptions = {},
    ) {}

    createDebugAdapterTracker(
        session: vscode.DebugSession,
    ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        if (process.platform === "win32") {
            return undefined
        }

        const opPath = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath", "op")
        const opRunner = new OpRunner(opPath)
        const getProcessTree = this.options.getProcessTree
            ?? createDefaultGetProcessTree(this.options.psRunner)

        return new SecretDebugAdapterTracker(
            this.registry,
            parseSessionConfig(session.configuration),
            opRunner,
            this.options.kill ?? ((pid, sig) => { process.kill(pid, sig) }),
            this.options.setKillTimer ?? setTimeout,
            this.options.clearKillTimer ?? clearTimeout,
            getProcessTree,
            this.options.getServiceAccountToken ?? (() => undefined),
        )
    }
}
