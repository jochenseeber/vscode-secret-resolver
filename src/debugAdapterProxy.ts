import * as path from "node:path"

import * as vscode from "vscode"

import type { DebugProtocol } from "@vscode/debugprotocol"
import { ConsoleLogger, type Logger } from "./logger"
import { OpRunner } from "./opRunner"
import { PgrepProcessFinder, PidtreeProcessTreeReader, type ProcessFinder, type ProcessTreeReader } from "./processTree"
import { RunInTerminalEnvRewriter } from "./runInTerminalEnvRewriter"
import { type SecretResolverSessionConfig, SessionConfigCodec } from "./sessionConfig"
import { NodeProcessController, type ProcessController, StopSignalController } from "./stopSignalController"
import { StringEnvMap } from "./stringEnvMap"
import { InMemoryTempDirRegistry, type TempDirRegistry } from "./tempDirRegistry"
import type { UserNotifier } from "./userNotifier"
import { WindowUserNotifier } from "./vscodeAdapters"

/**
 * Per-session tracker. For every `runInTerminal` request, the tracker merges
 * the resolved launch env with the request env, writes the result to a `0600`
 * dotenv file inside a `0700` temp directory under `os.tmpdir()`, swaps
 * `arguments.args` to invoke `op run --env-file=<path> -- <orig args>`, and
 * clears `arguments.env` (no-op when the merged env is empty). Cleanup runs
 * on `onWillStopSession` and `onExit`.
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
    private readonly directories: string[] = []

    constructor(
        private readonly registry: TempDirRegistry,
        private readonly sessionConfig: SecretResolverSessionConfig | undefined,
        private readonly runner: OpRunner,
        private readonly envRewriter: RunInTerminalEnvRewriter,
        private readonly stopSignals: StopSignalController,
    ) {}

    onDidSendMessage(message: unknown): void {
        this.stopSignals.onDidSendMessage(message)

        if (!SecretDebugAdapterTracker.isRunInTerminalRequest(message)) {
            return
        }

        const directory = this.envRewriter.rewrite(message, this.runner, this.sessionConfig)

        if (directory !== undefined) {
            this.directories.push(directory)
            this.registry.add(directory)
            // The unique temp-dir name appears in the rewritten `op run`
            // command line, so the stop-signal controller can locate the
            // wrapper by it when the terminal reports no PID.
            this.stopSignals.setLaunchMarker(path.basename(directory))
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
        while (this.directories.length > 0) {
            const directory = this.directories.pop()!

            InMemoryTempDirRegistry.removeDirectoryQuietly(directory)
            this.registry.remove(directory)
        }
    }

    /**
     * Type guard for a DAP `runInTerminal` request. Narrows `unknown` to
     * `RunInTerminalRequest` so the tracker can safely access `arguments.args`
     * and `arguments.env`.
     */
    private static isRunInTerminalRequest(
        message: unknown,
    ): message is DebugProtocol.RunInTerminalRequest {
        if (typeof message !== "object" || message === null) {
            return false
        }

        const candidate = message as Partial<DebugProtocol.RunInTerminalRequest>
        const isMatch = candidate.type === "request"
            && candidate.command === "runInTerminal"
            && Array.isArray(candidate.arguments?.args)
        return isMatch
    }
}

/**
 * Injectable collaborators for the tracker factory. Production leaves all of
 * them unset; tests inject recorders so no real processes, timers, or UI are
 * touched.
 */
export interface TrackerFactoryOptions {
    processController?: ProcessController
    /** Override the process-tree reader (defaults to a `pidtree`-backed one). */
    processTreeReader?: ProcessTreeReader
    /** Override the process finder (defaults to a `pgrep`-backed one). */
    processFinder?: ProcessFinder
    logger?: Logger
    notifier?: UserNotifier
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

        const logger = this.options.logger ?? new ConsoleLogger()
        const notifier = this.options.notifier ?? new WindowUserNotifier()
        const processController = this.options.processController ?? new NodeProcessController()
        const processTreeReader = this.options.processTreeReader
            ?? new PidtreeProcessTreeReader(logger)
        const processFinder = this.options.processFinder
            ?? new PgrepProcessFinder(logger)

        const sessionConfig = SessionConfigCodec.parse(session.configuration)
        const stopSignals = new StopSignalController(
            sessionConfig,
            processController,
            processTreeReader,
            processFinder,
            notifier,
            logger,
        )
        const launchEnv = SecretDebugAdapterTrackerFactory.readLaunchEnv(session.configuration)
        const envRewriter = new RunInTerminalEnvRewriter(notifier, logger, launchEnv)

        const tracker = new SecretDebugAdapterTracker(
            this.registry,
            sessionConfig,
            opRunner,
            envRewriter,
            stopSignals,
        )
        return tracker
    }

    /**
     * Reads the resolved launch env from `session.configuration.env` (the
     * `DebugConfiguration` the resolver produced). Every launch variable is
     * moved into the `op run` env file, even ones the adapter does not
     * forward in its `runInTerminal` request. Non-string values are dropped.
     */
    private static readLaunchEnv(configuration: vscode.DebugConfiguration): Record<string, string> {
        const raw = (configuration as Record<string, unknown>).env

        if (typeof raw !== "object" || raw === null) {
            const empty: Record<string, string> = {}
            return empty
        }

        const launchEnv = new StringEnvMap(raw as Record<string, string | null | undefined>).toRecord()
        return launchEnv
    }
}
