import type { Logger } from "./logger"
import type { ProcessFinder, ProcessTreeReader } from "./processTree"
import type { SecretResolverSessionConfig, SignalName, SignalStep } from "./sessionConfig"
import type { UserNotifier } from "./userNotifier"

/**
 * Process signaling and timer scheduling used by `StopSignalController`.
 * Pulled out so tests can inject recorders without spawning real processes
 * or waiting on real timers.
 */
export interface ProcessController {
    kill(pid: number, signal: NodeJS.Signals | number): void
    setTimer(callback: () => void, delayMs: number): NodeJS.Timeout
    clearTimer(handle: NodeJS.Timeout): void
}

/**
 * `ProcessController` backed by `process.kill` and the global timers.
 */
export class NodeProcessController implements ProcessController {
    kill(pid: number, signal: NodeJS.Signals | number): void {
        process.kill(pid, signal)
    }

    setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
        const handle = setTimeout(callback, delayMs)
        return handle
    }

    clearTimer(handle: NodeJS.Timeout): void {
        clearTimeout(handle)
    }
}

export class StopSignalController {
    private static readonly NODE_SIGNALS: Record<SignalName, NodeJS.Signals> = {
        TERM: "SIGTERM",
        KILL: "SIGKILL",
        INT: "SIGINT",
        HUP: "SIGHUP",
    }

    private pid: number | undefined
    private launchMarker: string | undefined
    private terminalLaunchObserved = false
    private programExited = false
    private pendingKillTimer: NodeJS.Timeout | undefined

    constructor(
        private readonly sessionConfig: SecretResolverSessionConfig | undefined,
        private readonly processController: ProcessController,
        private readonly processTreeReader: ProcessTreeReader,
        private readonly processFinder: ProcessFinder,
        private readonly notifier: UserNotifier,
        private readonly logger: Logger,
    ) {}

    /**
     * Records the per-launch unique marker (the temp-dir basename embedded in
     * the `op run --env-file=...` command line). Used to locate the launched
     * process when the `runInTerminal` response carries no PID — VS Code
     * reports none for external terminals.
     */
    setLaunchMarker(marker: string): void {
        this.launchMarker = marker
        this.terminalLaunchObserved = true
    }

    onDidSendMessage(message: unknown): void {
        if (StopSignalController.isDapEvent(message, "exited")) {
            this.programExited = true
            this.cancelPendingKill()
        }
    }

    onWillReceiveMessage(message: unknown): void {
        if (this.sessionConfig === undefined) {
            return
        }

        if (StopSignalController.isRunInTerminalResponse(message)) {
            this.terminalLaunchObserved = true

            const body = message.body as
                | { processId?: number; shellProcessId?: number }
                | undefined
            // Prefer `shellProcessId` — it's the runInTerminal shell, which
            // is the root we'll walk to find the actual program. `processId`
            // is a fallback when the shell PID is absent; we walk from
            // whichever PID we have.
            const pid = body?.shellProcessId ?? body?.processId

            if (typeof pid === "number" && pid > 0) {
                this.pid = pid
                this.logger.info(`launched process has PID ${pid}`)
            }

            return
        }

        if (
            StopSignalController.isDapRequest(message, "disconnect")
            && StopSignalController.shouldTerminateOnDisconnect(message)
            && !this.programExited
        ) {
            this.startSignalSequence(this.sessionConfig.steps)
        }
    }

    onExit(): void {
        this.cancelPendingKill()
    }

    /**
     * Entry point for the disconnect-triggered sequence. Uses the PID from
     * the `runInTerminal` response when available; otherwise falls back to
     * locating the launched process by the launch marker (external terminals
     * report no PID). Warns when a terminal launch cannot be pinned; stays
     * silent for launches without a terminal (`internalConsole`).
     */
    private startSignalSequence(steps: SignalStep[]): void {
        if (steps.length === 0 || !this.terminalLaunchObserved) {
            return
        }

        if (this.pid !== undefined) {
            this.dispatchSignalSequence(steps)
            return
        }

        if (this.launchMarker === undefined) {
            this.notifier.showWarning(
                "Secret Resolver: cannot signal the launched program — the terminal reported no PID and no launch marker is available.",
            )
            return
        }

        void this.findPidAndDispatch(steps, this.launchMarker)
    }

    private async findPidAndDispatch(steps: SignalStep[], marker: string): Promise<void> {
        const pid = await this.processFinder.findProcessIdByCommandLineMarker(marker)

        if (pid === null) {
            this.notifier.showWarning(
                `Secret Resolver: cannot signal the launched program — no process matching "${marker}" was found.`,
            )
            return
        }

        if (this.programExited) {
            return
        }

        this.pid = pid
        this.logger.info(`located launched process via marker "${marker}": PID ${pid}`)
        this.dispatchSignalSequence(steps)
    }

    private dispatchSignalSequence(steps: SignalStep[], index = 0): void {
        if (index >= steps.length || this.programExited || this.pid === undefined) {
            return
        }

        const step = steps[index]

        const go = (): void => {
            void this.signalProcessTree(this.pid!, StopSignalController.toNodeSignal(step.signal))
            this.dispatchSignalSequence(steps, index + 1)
        }

        if (step.delaySec > 0) {
            this.pendingKillTimer = this.processController.setTimer(() => {
                this.pendingKillTimer = undefined

                if (!this.programExited) {
                    go()
                }
            }, step.delaySec * 1_000)

            return
        }

        go()
    }

    private async signalProcessTree(
        rootPid: number,
        signal: NodeJS.Signals,
    ): Promise<void> {
        let pids: number[]

        try {
            pids = await this.processTreeReader.getProcessTree(rootPid)
        }
        catch (err) {
            this.logger.error(
                `failed to walk process tree of pid ${rootPid}: ${(err as Error).message}`,
            )
            pids = []
        }

        // Signal every process in the tree except the captured root itself.
        // The root is the runInTerminal shell (or, in the fallback, the
        // launched process) hosting the job; killing it would tear down the
        // terminal, so we leave it and signal everything beneath it —
        // regardless of whether the wrapper is `op run` or anything else.
        const targets = pids.filter((pid) => pid !== rootPid)

        if (targets.length === 0) {
            this.notifier.showWarning(
                `PID ${rootPid} has no descendants; nothing to ${signal}.`,
            )
            return
        }

        for (const pid of targets) {
            this.safeKill(pid, signal)
            this.logger.info(`sent ${signal} to PID ${pid}`)
        }
    }

    private cancelPendingKill(): void {
        if (this.pendingKillTimer !== undefined) {
            this.processController.clearTimer(this.pendingKillTimer)
            this.pendingKillTimer = undefined
        }
    }

    private safeKill(pid: number, signal: NodeJS.Signals): void {
        try {
            this.processController.kill(pid, signal)
        }
        catch (err) {
            const code = (err as NodeJS.ErrnoException).code

            // ESRCH = process already gone. Other errors (EPERM, EINVAL) are
            // worth logging; the session itself is unaffected.
            if (code !== "ESRCH") {
                this.logger.error(
                    `failed to send ${signal} to pid ${pid}: ${(err as Error).message}`,
                )
            }
        }
    }

    private static toNodeSignal(name: SignalName): NodeJS.Signals {
        const signal = StopSignalController.NODE_SIGNALS[name]
        return signal
    }

    private static shouldTerminateOnDisconnect(message: { arguments?: unknown }): boolean {
        const args = message.arguments as { terminateDebuggee?: unknown } | undefined
        const shouldTerminate = args?.terminateDebuggee !== false
        return shouldTerminate
    }

    private static isDapEvent(
        message: unknown,
        event: string,
    ): message is { type: "event"; event: string } {
        if (typeof message !== "object" || message === null) {
            return false
        }

        const candidate = message as { type?: unknown; event?: unknown }
        const isMatch = candidate.type === "event" && candidate.event === event
        return isMatch
    }

    private static isDapRequest(
        message: unknown,
        command: string,
    ): message is { type: "request"; command: string; arguments?: unknown } {
        if (typeof message !== "object" || message === null) {
            return false
        }

        const candidate = message as { type?: unknown; command?: unknown }
        const isMatch = candidate.type === "request" && candidate.command === command
        return isMatch
    }

    private static isRunInTerminalResponse(
        message: unknown,
    ): message is { type: "response"; command: "runInTerminal"; body?: unknown } {
        if (typeof message !== "object" || message === null) {
            return false
        }

        const candidate = message as { type?: unknown; command?: unknown }
        const isMatch = candidate.type === "response" && candidate.command === "runInTerminal"
        return isMatch
    }
}
