import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { DebugProtocol } from "@vscode/debugprotocol";
import { SecretDebugAdapterTrackerFactory, type TempDirRegistry } from "../../src/debugAdapterProxy";
import { parseEnvFile } from "../../src/dotenv";
import {
    cleanupRegistry,
    InMemoryTempDirRegistry,
    sweepStaleTempDirs,
    TEMP_DIR_PREFIX,
} from "../../src/tempDirRegistry";

function makeTracker(
    registry: TempDirRegistry = new InMemoryTempDirRegistry(),
): vscode.DebugAdapterTracker | undefined {
    return new SecretDebugAdapterTrackerFactory(registry)
        .createDebugAdapterTracker({} as vscode.DebugSession) as
            | vscode.DebugAdapterTracker
            | undefined;
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
    };
}

function configuredOpPath(): string {
    return vscode.workspace
        .getConfiguration("secretResolver")
        .get<string>("opPath", "op");
}

function readEnvFileFromArgs(args: readonly string[]): {
    envFilePath: string;
    parsed: Record<string, string>;
} {
    const flag = args.find((a) => a.startsWith("--env-file="));
    assert.ok(flag, "expected --env-file= argument");
    const envFilePath = flag.slice("--env-file=".length);
    // The dotenv writer escapes special chars but parseEnvFile only strips
    // outer quotes. Tests pick values that round-trip cleanly through both.
    return { envFilePath, parsed: readDotenvSync(envFilePath) };
}

function readDotenvSync(filePath: string): Record<string, string> {
    const out: Record<string, string> = {};
    const text = fs.readFileSync(filePath, "utf8");

    for (const rawLine of text.split(/\r?\n/)) {
        if (rawLine.length === 0) {
            continue;
        }

        const eq = rawLine.indexOf("=");
        const key = rawLine.slice(0, eq);
        let value = rawLine.slice(eq + 1);

        if (
            value.length >= 2
            && value.startsWith("\"")
            && value.endsWith("\"")
        ) {
            value = value.slice(1, -1);
        }

        out[key] = value;
    }

    return out;
}

suite("runtime integration", () => {
    test("wraps env in op run --env-file when env has op:// refs (op-run mode)", async () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);
        assert.ok(tracker);

        const message = makeRequest(["node", "app.js"], {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        });

        tracker?.onDidSendMessage?.(message);

        const args = message.arguments.args;
        assert.strictEqual(args[0], configuredOpPath());
        assert.strictEqual(args[1], "run");
        assert.ok(args[2].startsWith("--env-file="));
        assert.strictEqual(args[3], "--");
        assert.deepStrictEqual(args.slice(4), ["node", "app.js"]);

        assert.deepStrictEqual(message.arguments.env, {});

        const { envFilePath, parsed } = readEnvFileFromArgs(args);
        assert.deepStrictEqual(parsed, {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        });

        const stat = fs.statSync(envFilePath);
        assert.strictEqual(stat.mode & 0o777, 0o600);
        const dirStat = fs.statSync(path.dirname(envFilePath));
        assert.strictEqual(dirStat.mode & 0o777, 0o700);

        // cleanup so the registry sweep doesn't leave residue.
        cleanupRegistry(registry);
        assert.ok(!fs.existsSync(envFilePath));
    });

    test("wraps env in op run --env-file when env has plaintext (cache mode)", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);

        const message = makeRequest(["node", "app.js"], {
            DB_URL: "postgres://example",
            LOG_LEVEL: "info",
        });

        tracker?.onDidSendMessage?.(message);

        const { envFilePath, parsed } = readEnvFileFromArgs(message.arguments.args);
        assert.deepStrictEqual(parsed, {
            DB_URL: "postgres://example",
            LOG_LEVEL: "info",
        });
        assert.ok(!Object.values(parsed).some((v) => v.startsWith("op://")));

        cleanupRegistry(registry);
        assert.ok(!fs.existsSync(envFilePath));
    });

    test("wraps any terminal launch with non-empty env (no op:// refs needed)", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);

        const message = makeRequest(["node", "app.js"], {
            FOO: "bar",
        });

        tracker?.onDidSendMessage?.(message);

        const args = message.arguments.args;
        assert.strictEqual(args[0], configuredOpPath());
        assert.strictEqual(args[1], "run");
        assert.ok(args[2].startsWith("--env-file="));

        cleanupRegistry(registry);
    });

    test("no-op when env is missing", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);

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
        };
        const argsBefore = [...message.arguments.args];

        tracker?.onDidSendMessage?.(message);

        assert.deepStrictEqual(message.arguments.args, argsBefore);
        assert.strictEqual(registry.snapshot().length, 0);
    });

    test("no-op when env is empty", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);
        const message = makeRequest(["node", "app.js"], {});
        const argsBefore = [...message.arguments.args];

        tracker?.onDidSendMessage?.(message);

        assert.deepStrictEqual(message.arguments.args, argsBefore);
        assert.strictEqual(registry.snapshot().length, 0);
    });

    test("ignores non-runInTerminal messages", () => {
        if (process.platform === "win32") {
            return;
        }

        const tracker = makeTracker();
        const message = {
            seq: 2,
            type: "event",
            event: "stopped",
        } as unknown as DebugProtocol.RunInTerminalRequest;
        const before = JSON.stringify(message);

        tracker?.onDidSendMessage?.(message);

        assert.strictEqual(JSON.stringify(message), before);
    });

    test("ignores malformed runInTerminal payloads", () => {
        if (process.platform === "win32") {
            return;
        }

        const tracker = makeTracker();
        const message = {
            seq: 3,
            type: "request",
            command: "runInTerminal",
            arguments: {},
        } as unknown as DebugProtocol.RunInTerminalRequest;

        tracker?.onDidSendMessage?.(message);

        assert.deepStrictEqual(message.arguments, {});
    });

    test("removes the temp dir on onWillStopSession", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry) as
            | (vscode.DebugAdapterTracker & {
                onWillStopSession?: () => void;
            })
            | undefined;
        assert.ok(tracker);

        const message = makeRequest(["node", "app.js"], { FOO: "bar" });
        tracker.onDidSendMessage?.(message);
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args);
        assert.ok(fs.existsSync(envFilePath));

        tracker.onWillStopSession?.();

        assert.ok(!fs.existsSync(envFilePath));
        assert.strictEqual(registry.snapshot().length, 0);
    });

    test("removes the temp dir on onExit", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry) as
            | (vscode.DebugAdapterTracker & {
                onExit?: (code?: number, signal?: string) => void;
            })
            | undefined;
        assert.ok(tracker);

        const message = makeRequest(["node", "app.js"], { FOO: "bar" });
        tracker.onDidSendMessage?.(message);
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args);
        assert.ok(fs.existsSync(envFilePath));

        tracker.onExit?.(0, undefined);

        assert.ok(!fs.existsSync(envFilePath));
        assert.strictEqual(registry.snapshot().length, 0);
    });

    test("cleanupRegistry removes any leftover dirs", () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);

        const message = makeRequest(["node", "app.js"], { FOO: "bar" });
        tracker?.onDidSendMessage?.(message);
        const { envFilePath } = readEnvFileFromArgs(message.arguments.args);
        const dir = path.dirname(envFilePath);
        assert.ok(fs.existsSync(dir));

        cleanupRegistry(registry);

        assert.ok(!fs.existsSync(dir));
        assert.strictEqual(registry.snapshot().length, 0);
    });

    test("activation-time sweep removes dirs whose owning PID is gone", () => {
        if (process.platform === "win32") {
            return;
        }

        const root = os.tmpdir();
        const stale = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX));
        const deadPid = pickDeadPid();
        fs.writeFileSync(path.join(stale, ".pid"), String(deadPid), {
            mode: 0o600,
        });
        fs.writeFileSync(path.join(stale, "env"), "FOO=bar\n", { mode: 0o600 });

        sweepStaleTempDirs();

        assert.ok(!fs.existsSync(stale));
    });

    test("activation-time sweep leaves alive-PID dirs alone", () => {
        if (process.platform === "win32") {
            return;
        }

        const root = os.tmpdir();
        const live = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX));
        fs.writeFileSync(path.join(live, ".pid"), String(process.pid), {
            mode: 0o600,
        });
        fs.writeFileSync(path.join(live, "env"), "FOO=bar\n", { mode: 0o600 });

        try {
            sweepStaleTempDirs();
            assert.ok(fs.existsSync(live));
        }
        finally {
            fs.rmSync(live, { recursive: true, force: true });
        }
    });

    test("activation-time sweep leaves dirs without .pid alone", () => {
        if (process.platform === "win32") {
            return;
        }

        const root = os.tmpdir();
        const orphan = fs.mkdtempSync(path.join(root, TEMP_DIR_PREFIX));
        fs.writeFileSync(path.join(orphan, "env"), "FOO=bar\n", {
            mode: 0o600,
        });

        try {
            sweepStaleTempDirs();
            assert.ok(fs.existsSync(orphan));
        }
        finally {
            fs.rmSync(orphan, { recursive: true, force: true });
        }
    });

    test("formatDotenv output is parseable by parseEnvFile for safe values", async () => {
        if (process.platform === "win32") {
            return;
        }

        const registry = new InMemoryTempDirRegistry();
        const tracker = makeTracker(registry);
        const message = makeRequest(["node", "app.js"], {
            URL: "https://example.com/path",
            REF: "op://vault/item/url",
        });

        tracker?.onDidSendMessage?.(message);

        const { envFilePath } = readEnvFileFromArgs(message.arguments.args);
        const parsed = await parseEnvFile(envFilePath);
        assert.deepStrictEqual(parsed, {
            URL: "https://example.com/path",
            REF: "op://vault/item/url",
        });

        cleanupRegistry(registry);
    });
});

function pickDeadPid(): number {
    // PIDs are recycled; find one that is currently not alive. Start high
    // and walk down. Caller is responsible for the slim race that the kernel
    // hands this PID to a fresh process between the check and the sweep.
    for (let candidate = 999999; candidate > 1000; candidate -= 7919) {
        try {
            process.kill(candidate, 0);
        }
        catch (err) {
            const code = (err as NodeJS.ErrnoException).code;

            if (code === "ESRCH") {
                return candidate;
            }
        }
    }

    throw new Error("could not find a dead pid");
}
