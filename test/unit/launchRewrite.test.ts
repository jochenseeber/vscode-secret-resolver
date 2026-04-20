import * as assert from "node:assert";

import { isRunInTerminalRequest, prependOpRun } from "../../src/launchRewrite";

suite("isRunInTerminalRequest", () => {
    test("accepts a well-formed runInTerminal request", () => {
        const message = {
            seq: 1,
            type: "request",
            command: "runInTerminal",
            arguments: {
                kind: "integrated",
                title: "test",
                cwd: "/tmp",
                args: ["node", "app.js"],
                env: {},
            },
        };
        assert.strictEqual(isRunInTerminalRequest(message), true);
    });

    test("rejects null and primitives", () => {
        assert.strictEqual(isRunInTerminalRequest(null), false);
        assert.strictEqual(isRunInTerminalRequest(undefined), false);
        assert.strictEqual(isRunInTerminalRequest("request"), false);
        assert.strictEqual(isRunInTerminalRequest(42), false);
    });

    test("rejects events and responses", () => {
        assert.strictEqual(
            isRunInTerminalRequest({ type: "event", event: "stopped" }),
            false,
        );
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "response",
                command: "runInTerminal",
                arguments: { args: [] },
            }),
            false,
        );
    });

    test("rejects requests with a different command", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "launch",
                arguments: { args: ["node"] },
            }),
            false,
        );
    });

    test("rejects runInTerminal with non-array args", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
                arguments: { args: "node app.js" },
            }),
            false,
        );
    });

    test("rejects runInTerminal with missing arguments", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
            }),
            false,
        );
    });

    test("accepts runInTerminal with empty args array", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
                arguments: { args: [] },
            }),
            true,
        );
    });
});

suite("prependOpRun", () => {
    test("prepends the op path, run, and -- separator", () => {
        assert.deepStrictEqual(
            prependOpRun(["node", "app.js"], "op"),
            ["op", "run", "--", "node", "app.js"],
        );
    });

    test("honors an absolute op path", () => {
        assert.deepStrictEqual(
            prependOpRun(["python", "-m", "svc"], "/opt/homebrew/bin/op"),
            ["/opt/homebrew/bin/op", "run", "--", "python", "-m", "svc"],
        );
    });

    test("handles an empty args array", () => {
        assert.deepStrictEqual(
            prependOpRun([], "op"),
            ["op", "run", "--"],
        );
    });

    test("does not mutate the input args", () => {
        const input = ["node", "app.js"];
        const snapshot = [...input];
        prependOpRun(input, "op");
        assert.deepStrictEqual(input, snapshot);
    });

    test("preserves arg values verbatim (no quoting or escaping)", () => {
        assert.deepStrictEqual(
            prependOpRun(["echo", "hello world", "a'b\"c"], "op"),
            ["op", "run", "--", "echo", "hello world", "a'b\"c"],
        );
    });
});
