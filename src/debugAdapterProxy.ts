import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { formatDotenv } from "./dotenv";
import type { SignalName, SignalStep, StringEnvMap } from "./envHelpers";
import { buildOpRunArgs, isRunInTerminalRequest } from "./launchRewrite";
import { defaultGetProcessTree, type GetProcessTreeFn, isOpRunCommand, type ProcessInfo } from "./processTree";
import { SECRET_RESOLVER_CONFIG_FIELD, type SecretResolverSessionConfig } from "./resolveLaunchConfig";

// Re-exports kept for the integration tests + any future external consumers.
export { type GetProcessTreeFn, isOpRunCommand, type ProcessInfo } from "./processTree";

/**
 * Master registry of temp dirs the trackers have created. Owned by
 * `extension.ts`; the registry survives across debug sessions and lets the
 * extension drive cleanup from `deactivate`, signal handlers, and the
 * activation-time stale-dir sweep.
 */
export interface TempDirRegistry {
    add(dir: string): void;
    remove(dir: string): void;
}

/**
 * Signature of `process.kill`. Pulled out so tests can inject a recorder
 * without spawning real processes.
 */
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

/**
 * Per-session tracker. For every `runInTerminal` request whose env has at
 * least one non-null entry, the tracker writes the env to a `0600` dotenv
 * file inside a `0700` temp dir under `os.tmpdir()`, swaps `arguments.args`
 * to invoke `op run --env-file=<path> -- <orig args>`, and clears
 * `arguments.env`. Cleanup runs on `onWillStopSession` and `onExit`.
 *
 * When the session config carries a `__secretResolver` block (set by the
 * resolver when `SECRET_RESOLVER_SIGNAL_ON_STOP` is configured for a
 * terminal launch), the tracker also captures the spawned PID from the
 * `runInTerminal` response, watches for the user's Stop request via the
 * DAP `disconnect` request, and signals the program. Detach
 * (`terminateDebuggee === false`) is a no-op.
 *
 * Caveat: VS Code's tracker API is documented as observation-only. The
 * mutations of `arguments.args` and `arguments.env` rely on messages being
 * passed by reference and dispatched after the hook returns — the practical
 * reality for years, but not a formal guarantee.
 */
class SecretDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private readonly dirs: string[] = [];
    private pid: number | undefined;
    private programExited = false;
    private pendingKillTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly registry: TempDirRegistry,
        private readonly signalConfig: SecretResolverSessionConfig | undefined,
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
            this.programExited = true;
            this.cancelPendingKill();
            return;
        }

        if (!isRunInTerminalRequest(message)) {
            return;
        }

        const stringEnv = toStringEnv(message.arguments.env);

        if (Object.keys(stringEnv).length === 0) {
            return;
        }

        let createdDir: string | undefined;

        try {
            const opPath = vscode.workspace
                .getConfiguration("secretResolver")
                .get<string>("opPath", "op");

            const dir = fs.mkdtempSync(
                path.join(os.tmpdir(), "secret-resolver-"),
            );
            createdDir = dir;
            const envFilePath = path.join(dir, "env");
            fs.writeFileSync(envFilePath, formatDotenv(stringEnv), {
                mode: 0o600,
            });
            fs.writeFileSync(path.join(dir, ".pid"), String(process.pid), {
                mode: 0o600,
            });

            this.dirs.push(dir);
            this.registry.add(dir);

            message.arguments.args = buildOpRunArgs(
                opPath,
                envFilePath,
                message.arguments.args,
            );
            message.arguments.env = {};
        }
        catch (err) {
            if (createdDir !== undefined) {
                try {
                    fs.rmSync(createdDir, { recursive: true, force: true });
                }
                catch {
                    // best-effort
                }
            }

            console.error(
                `[secret-resolver] runInTerminal rewrite failed: ${(err as Error).message}`,
            );
        }
    }

    onWillReceiveMessage(message: unknown): void {
        if (this.signalConfig === undefined) {
            return;
        }

        if (isRunInTerminalResponse(message)) {
            const body = message.body as
                | { processId?: number; shellProcessId?: number }
                | undefined;
            // Prefer `shellProcessId` — it's the runInTerminal shell, which
            // is the root we'll walk to find the actual program. `processId`
            // is a fallback when the shell PID is absent; we walk from
            // whichever PID we have.
            const pid = body?.shellProcessId ?? body?.processId;

            if (typeof pid === "number" && pid > 0) {
                this.pid = pid;
                showTimedNotification(`Launched process has PID ${pid}`);
            }

            return;
        }

        if (
            isDapRequest(message, "disconnect")
            && shouldTerminateOnDisconnect(message)
            && this.pid !== undefined
            && !this.programExited
        ) {
            this.dispatchSignalSequence(this.signalConfig.steps);
        }
    }

    onWillStopSession(): void {
        this.cleanup();
    }

    onExit(): void {
        this.cancelPendingKill();
        this.cleanup();
    }

    private dispatchSignalSequence(steps: SignalStep[], index = 0): void {
        if (index >= steps.length || this.programExited || this.pid === undefined) {
            return;
        }

        const step = steps[index];

        const go = (): void => {
            void this.signalProcessTree(this.pid!, toNodeSignal(step.signal));
            this.dispatchSignalSequence(steps, index + 1);
        };

        if (step.delaySec > 0) {
            this.pendingKillTimer = this.setKillTimer(() => {
                this.pendingKillTimer = undefined;

                if (!this.programExited) {
                    go();
                }
            }, step.delaySec * 1000);

            return;
        }

        go();
    }

    private async signalProcessTree(
        rootPid: number,
        signal: NodeJS.Signals,
    ): Promise<void> {
        let tree: ProcessInfo[];

        try {
            tree = await this.getProcessTree(rootPid);
        }
        catch (err) {
            console.error(
                `[secret-resolver] failed to walk process tree of pid ${rootPid}: ${(err as Error).message}`,
            );
            tree = [];
        }

        if (tree.length === 0) {
            showTimedNotification(`PID ${rootPid} has no children, nothing to signal.`);
            return;
        }

        // Locate every `op run` wrapper anywhere in the tree, then signal
        // only their direct children. The wrapper itself is left alone (it
        // exits naturally when its child does), and processes outside the
        // wrap (e.g. the shell hosting the runInTerminal job) are not
        // touched.
        const opPids = new Set(
            tree.filter((p) => isOpRunCommand(p.command)).map((p) => p.pid),
        );

        if (opPids.size === 0) {
            showTimedNotification(`PID ${rootPid} has no \`op\` child; nothing to ${signal}.`);
            return;
        }

        const targets = tree.filter((p) => opPids.has(p.ppid));

        if (targets.length === 0) {
            showTimedNotification(
                `\`op\` wrapper(s) (${[...opPids].join(", ")}) have no children; nothing to ${signal}.`,
            );
            return;
        }

        for (const target of targets) {
            safeKill(this.kill, target.pid, signal);
            showTimedNotification(`Sent ${signal} to PID ${target.pid}`);
        }
    }

    private cancelPendingKill(): void {
        if (this.pendingKillTimer !== undefined) {
            this.clearKillTimer(this.pendingKillTimer);
            this.pendingKillTimer = undefined;
        }
    }

    private cleanup(): void {
        while (this.dirs.length > 0) {
            const dir = this.dirs.pop()!;

            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }

            this.registry.remove(dir);
        }
    }
}

export class SecretDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(
        private readonly registry: TempDirRegistry,
        private readonly kill: KillFn = (pid, sig) => {
            process.kill(pid, sig);
        },
        private readonly setKillTimer: (
            cb: () => void,
            ms: number,
        ) => NodeJS.Timeout = setTimeout,
        private readonly clearKillTimer: (handle: NodeJS.Timeout) => void = clearTimeout,
        private readonly getProcessTree: GetProcessTreeFn = defaultGetProcessTree,
    ) {}

    createDebugAdapterTracker(
        session: vscode.DebugSession,
    ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        if (process.platform === "win32") {
            return undefined;
        }

        return new SecretDebugAdapterTracker(
            this.registry,
            extractSignalConfig(session),
            this.kill,
            this.setKillTimer,
            this.clearKillTimer,
            this.getProcessTree,
        );
    }
}

function toNodeSignal(name: SignalName): NodeJS.Signals {
    switch (name) {
        case "TERM":
            return "SIGTERM";
        case "KILL":
            return "SIGKILL";
        case "INT":
            return "SIGINT";
        case "HUP":
            return "SIGHUP";
    }
}

function isSignalStep(x: unknown): x is SignalStep {
    if (typeof x !== "object" || x === null) {
        return false;
    }

    const s = x as Partial<SignalStep>;

    return (
        typeof s.delaySec === "number"
        && s.delaySec >= 0
        && (s.signal === "TERM"
            || s.signal === "KILL"
            || s.signal === "INT"
            || s.signal === "HUP")
    );
}

function extractSignalConfig(
    session: vscode.DebugSession,
): SecretResolverSessionConfig | undefined {
    const raw = (session.configuration as Record<string, unknown> | undefined)
        ?.[SECRET_RESOLVER_CONFIG_FIELD];

    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const candidate = raw as { steps?: unknown };

    if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
        return undefined;
    }

    if (!candidate.steps.every(isSignalStep)) {
        return undefined;
    }

    return { steps: candidate.steps };
}

function safeKill(kill: KillFn, pid: number, signal: NodeJS.Signals): void {
    try {
        kill(pid, signal);
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        // ESRCH = process already gone. Other errors (EPERM, EINVAL) are
        // worth logging; the session itself is unaffected.
        if (code !== "ESRCH") {
            console.error(
                `[secret-resolver] failed to send ${signal} to pid ${pid}: ${(err as Error).message}`,
            );
        }
    }
}

function showTimedNotification(message: string, timeoutMs = 10_000): void {
    void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message, cancellable: false },
        () => new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    );
}

function isDapEvent(
    message: unknown,
    event: string,
): message is { type: "event"; event: string } {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const m = message as { type?: unknown; event?: unknown };
    return m.type === "event" && m.event === event;
}

function isDapRequest(
    message: unknown,
    command: string,
): message is { type: "request"; command: string; arguments?: unknown } {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const m = message as { type?: unknown; command?: unknown };
    return m.type === "request" && m.command === command;
}

function isRunInTerminalResponse(
    message: unknown,
): message is { type: "response"; command: "runInTerminal"; body?: unknown } {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const m = message as { type?: unknown; command?: unknown };
    return m.type === "response" && m.command === "runInTerminal";
}

function shouldTerminateOnDisconnect(message: {
    arguments?: unknown;
}): boolean {
    const args = message.arguments as
        | { terminateDebuggee?: unknown }
        | undefined;

    return args?.terminateDebuggee !== false;
}

function toStringEnv(
    env: Record<string, string | null> | undefined,
): StringEnvMap {
    const out: StringEnvMap = {};

    if (env === undefined || env === null) {
        return out;
    }

    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
            out[key] = value;
        }
    }

    return out;
}
