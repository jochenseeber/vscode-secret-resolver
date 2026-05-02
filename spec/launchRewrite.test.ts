import * as assert from "node:assert"

import { buildOpRunArgs, isRunInTerminalRequest } from "../src/launchRewrite"

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
        }
        assert.strictEqual(isRunInTerminalRequest(message), true)
    })

    test("rejects null and primitives", () => {
        assert.strictEqual(isRunInTerminalRequest(null), false)
        assert.strictEqual(isRunInTerminalRequest(undefined), false)
        assert.strictEqual(isRunInTerminalRequest("request"), false)
        assert.strictEqual(isRunInTerminalRequest(42), false)
    })

    test("rejects events and responses", () => {
        assert.strictEqual(
            isRunInTerminalRequest({ type: "event", event: "stopped" }),
            false,
        )
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "response",
                command: "runInTerminal",
                arguments: { args: [] },
            }),
            false,
        )
    })

    test("rejects requests with a different command", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "launch",
                arguments: { args: ["node"] },
            }),
            false,
        )
    })

    test("rejects runInTerminal with non-array args", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
                arguments: { args: "node app.js" },
            }),
            false,
        )
    })

    test("rejects runInTerminal with missing arguments", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
            }),
            false,
        )
    })

    test("accepts runInTerminal with empty args array", () => {
        assert.strictEqual(
            isRunInTerminalRequest({
                type: "request",
                command: "runInTerminal",
                arguments: { args: [] },
            }),
            true,
        )
    })
})

suite("buildOpRunArgs", () => {
    test("wraps the args with op run --env-file and a -- separator", () => {
        assert.deepStrictEqual(
            buildOpRunArgs("op", "/tmp/sr/env", ["node", "app.js"]),
            ["op", "run", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })

    test("honors an absolute op path", () => {
        assert.deepStrictEqual(
            buildOpRunArgs(
                "/opt/homebrew/bin/op",
                "/tmp/sr/env",
                ["python", "-m", "svc"],
            ),
            [
                "/opt/homebrew/bin/op",
                "run",
                "--env-file=/tmp/sr/env",
                "--",
                "python",
                "-m",
                "svc",
            ],
        )
    })

    test("handles an empty args array", () => {
        assert.deepStrictEqual(
            buildOpRunArgs("op", "/tmp/sr/env", []),
            ["op", "run", "--env-file=/tmp/sr/env", "--"],
        )
    })

    test("does not mutate the input args", () => {
        const input = ["node", "app.js"]
        const snapshot = [...input]
        buildOpRunArgs("op", "/tmp/sr/env", input)
        assert.deepStrictEqual(input, snapshot)
    })

    test("preserves arg values verbatim (no quoting or escaping)", () => {
        assert.deepStrictEqual(
            buildOpRunArgs("op", "/tmp/sr/env", [
                "echo",
                "hello world",
                "a'b\"c",
            ]),
            [
                "op",
                "run",
                "--env-file=/tmp/sr/env",
                "--",
                "echo",
                "hello world",
                "a'b\"c",
            ],
        )
    })

    test("inserts --account before --env-file when account is provided", () => {
        assert.deepStrictEqual(
            buildOpRunArgs("op", "/tmp/sr/env", ["node", "app.js"], "my-account"),
            ["op", "run", "--account", "my-account", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })

    test("omits --account when account is undefined", () => {
        assert.deepStrictEqual(
            buildOpRunArgs("op", "/tmp/sr/env", ["node", "app.js"], undefined),
            ["op", "run", "--env-file=/tmp/sr/env", "--", "node", "app.js"],
        )
    })
})
