import * as assert from "node:assert"

import { isRunInTerminalRequest } from "../src/launchRewrite"

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
