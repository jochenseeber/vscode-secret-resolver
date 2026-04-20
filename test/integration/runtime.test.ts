import * as assert from "node:assert";
import * as os from "node:os";
import * as vscode from "vscode";

import { DebugProtocol } from "@vscode/debugprotocol";
import { SecretDebugAdapterTrackerFactory } from "../../src/debugAdapterProxy";

function makeTracker(): vscode.DebugAdapterTracker | undefined {
    return new SecretDebugAdapterTrackerFactory()
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

suite("runtime integration", () => {
    test("prepends the configured op binary to runInTerminal args", () => {
        if (process.platform === "win32") {
            return;
        }

        const tracker = makeTracker();
        assert.ok(tracker);

        const message = makeRequest(["node", "app.js"], {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        });

        tracker?.onDidSendMessage?.(message);

        const configured = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath", "op");
        assert.deepStrictEqual(message.arguments.args, [
            configured,
            "run",
            "--",
            "node",
            "app.js",
        ]);
    });

    test("leaves the env field untouched so op run inherits op:// refs", () => {
        if (process.platform === "win32") {
            return;
        }

        const tracker = makeTracker();
        const env = {
            DB_URL: "op://vault/item/url",
            LOG_LEVEL: "info",
        };
        const message = makeRequest(["node", "app.js"], env);

        tracker?.onDidSendMessage?.(message);

        assert.deepStrictEqual(message.arguments.env, env);
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
});
