import * as vscode from "vscode";

import { isRunInTerminalRequest, prependOpRun } from "./launchRewrite";

/**
 * Observes DAP traffic for `runInTerminal` requests and mutates the args in
 * place to prepend `op run --`. The env field carries op:// references from
 * launch.json through to the spawned shell; `op run` inherits that env,
 * resolves any references, and execs the real command. Plaintext never
 * touches extension memory.
 *
 * Caveat: VS Code's tracker API is documented as observation-only. This
 * mutation relies on messages being passed to trackers by reference and
 * dispatched by VS Code *after* all trackers return — the practical reality
 * for years, but not a formal guarantee. If a future VS Code release
 * defensively copies tracker messages, the `op run` prefix silently stops
 * being applied; the debug session itself keeps working, just with
 * unresolved op:// refs reaching the target.
 */
class SecretDebugAdapterTracker implements vscode.DebugAdapterTracker {
    onDidSendMessage(message: unknown): void {
        if (!isRunInTerminalRequest(message)) {
            return;
        }

        try {
            const opPath = vscode.workspace
                .getConfiguration("secretResolver")
                .get<string>("opPath", "op");
            message.arguments.args = prependOpRun(message.arguments.args, opPath);
        }
        catch (err) {
            console.error(
                `[secret-resolver] runInTerminal rewrite failed: ${(err as Error).message}`,
            );
            // Leave the request unchanged — session continues without op run.
        }
    }
}

export class SecretDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    createDebugAdapterTracker(
        _session: vscode.DebugSession,
    ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        // `op run --` prefix is POSIX-oriented; Windows uses op.exe with
        // different invocation conventions and isn't supported here.
        if (process.platform === "win32") {
            return undefined;
        }

        return new SecretDebugAdapterTracker();
    }
}
