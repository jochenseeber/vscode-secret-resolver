import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { formatDotenv } from "./dotenv";
import type { StringEnvMap } from "./envHelpers";
import { buildOpRunArgs, isRunInTerminalRequest } from "./launchRewrite";

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
 * Per-session tracker. For every `runInTerminal` request whose env has at
 * least one non-null entry, the tracker writes the env to a `0600` dotenv
 * file inside a `0700` temp dir under `os.tmpdir()`, swaps `arguments.args`
 * to invoke `op run --env-file=<path> -- <orig args>`, and clears
 * `arguments.env`. Cleanup runs on `onWillStopSession` and `onExit`.
 *
 * Caveat: VS Code's tracker API is documented as observation-only. The
 * mutations of `arguments.args` and `arguments.env` rely on messages being
 * passed by reference and dispatched after the hook returns — the practical
 * reality for years, but not a formal guarantee.
 */
class SecretDebugAdapterTracker implements vscode.DebugAdapterTracker {
    private readonly dirs: string[] = [];

    constructor(private readonly registry: TempDirRegistry) {}

    onDidSendMessage(message: unknown): void {
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

    onWillStopSession(): void {
        this.cleanup();
    }

    onExit(): void {
        this.cleanup();
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
    constructor(private readonly registry: TempDirRegistry) {}

    createDebugAdapterTracker(
        _session: vscode.DebugSession,
    ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        if (process.platform === "win32") {
            return undefined;
        }

        return new SecretDebugAdapterTracker(this.registry);
    }
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
