import * as vscode from "vscode"

import type { SignalName, SignalStep } from "./envHelpers"
import { type GetProcessTreeFn, isOpRunCommand, type ProcessInfo } from "./processTree"
import type { SecretResolverSessionConfig } from "./sessionConfig"

/**
 * Signature of `process.kill`. Pulled out so tests can inject a recorder
 * without spawning real processes.
 */
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void

export class StopSignalController {
    private pid: number | undefined
    private programExited = false
    private pendingKillTimer: NodeJS.Timeout | undefined

    constructor(
        private readonly sessionConfig: SecretResolverSessionConfig | undefined,
        private readonly kill: KillFn,
        private readonly setKillTimer: (
            cb: () => void,
            ms: number,
        ) => NodeJS.Timeout,
        private readonly clearKillTimer: (handle: NodeJS.Timeout) => void,
        private readonly getProcessTree: GetProcessTreeFn,
    ) {}

    onDidSendMessage(message: unknown): void {
        if (isDapEvent(message, "exited")) {
            this.programExited = true
            this.cancelPendingKill()
        }
    }

    onWillReceiveMessage(message: unknown): void {
        if (this.sessionConfig === undefined) {
            return
        }

        if (isRunInTerminalResponse(message)) {
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
                console.info(`[secret-resolver] launched process has PID ${pid}`)
            }

            return
        }

        if (
            isDapRequest(message, "disconnect")
            && shouldTerminateOnDisconnect(message)
            && this.pid !== undefined
            && !this.programExited
        ) {
            this.dispatchSignalSequence(this.sessionConfig.steps)
        }
    }

    onExit(): void {
        this.cancelPendingKill()
    }

    private dispatchSignalSequence(steps: SignalStep[], index = 0): void {
        if (index >= steps.length || this.programExited || this.pid === undefined) {
            return
        }

        const step = steps[index]

        const go = (): void => {
            void this.signalProcessTree(this.pid!, toNodeSignal(step.signal))
            this.dispatchSignalSequence(steps, index + 1)
        }

        if (step.delaySec > 0) {
            this.pendingKillTimer = this.setKillTimer(() => {
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
        let tree: ProcessInfo[]

        try {
            tree = await this.getProcessTree(rootPid)
        }
        catch (err) {
            console.error(
                `[secret-resolver] failed to walk process tree of pid ${rootPid}: ${(err as Error).message}`,
            )
            tree = []
        }

        if (tree.length === 0) {
            void vscode.window.showWarningMessage(`PID ${rootPid} has no children, nothing to signal.`)
            return
        }

        // Locate every `op run` wrapper anywhere in the tree, then signal
        // only their direct children. The wrapper itself is left alone (it
        // exits naturally when its child does), and processes outside the
        // wrap (e.g. the shell hosting the runInTerminal job) are not
        // touched.
        const opPids = new Set(
            tree.filter((p) => isOpRunCommand(p.command)).map((p) => p.pid),
        )

        if (opPids.size === 0) {
            void vscode.window.showWarningMessage(`PID ${rootPid} has no \`op\` child; nothing to ${signal}.`)
            return
        }

        const targets = tree.filter((p) => opPids.has(p.ppid))

        if (targets.length === 0) {
            void vscode.window.showWarningMessage(
                `\`op\` wrapper(s) (${[...opPids].join(", ")}) have no children; nothing to ${signal}.`,
            )
            return
        }

        for (const target of targets) {
            safeKill(this.kill, target.pid, signal)
            console.info(`[secret-resolver] sent ${signal} to PID ${target.pid}`)
        }
    }

    private cancelPendingKill(): void {
        if (this.pendingKillTimer !== undefined) {
            this.clearKillTimer(this.pendingKillTimer)
            this.pendingKillTimer = undefined
        }
    }
}

const NODE_SIGNALS: Record<SignalName, NodeJS.Signals> = {
    TERM: "SIGTERM",
    KILL: "SIGKILL",
    INT: "SIGINT",
    HUP: "SIGHUP",
}

function toNodeSignal(name: SignalName): NodeJS.Signals {
    const signal = NODE_SIGNALS[name]
    return signal
}

function safeKill(kill: KillFn, pid: number, signal: NodeJS.Signals): void {
    try {
        kill(pid, signal)
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code

        // ESRCH = process already gone. Other errors (EPERM, EINVAL) are
        // worth logging; the session itself is unaffected.
        if (code !== "ESRCH") {
            console.error(
                `[secret-resolver] failed to send ${signal} to pid ${pid}: ${(err as Error).message}`,
            )
        }
    }
}

function isDapEvent(
    message: unknown,
    event: string,
): message is { type: "event"; event: string } {
    if (typeof message !== "object" || message === null) {
        return false
    }

    const m = message as { type?: unknown; event?: unknown }
    const isMatch = m.type === "event" && m.event === event
    return isMatch
}

function isDapRequest(
    message: unknown,
    command: string,
): message is { type: "request"; command: string; arguments?: unknown } {
    if (typeof message !== "object" || message === null) {
        return false
    }

    const m = message as { type?: unknown; command?: unknown }
    const isMatch = m.type === "request" && m.command === command
    return isMatch
}

function isRunInTerminalResponse(
    message: unknown,
): message is { type: "response"; command: "runInTerminal"; body?: unknown } {
    if (typeof message !== "object" || message === null) {
        return false
    }

    const m = message as { type?: unknown; command?: unknown }
    const isMatch = m.type === "response" && m.command === "runInTerminal"
    return isMatch
}

function shouldTerminateOnDisconnect(message: {
    arguments?: unknown
}): boolean {
    const args = message.arguments as
        | { terminateDebuggee?: unknown }
        | undefined

    const shouldTerminate = args?.terminateDebuggee !== false
    return shouldTerminate
}
