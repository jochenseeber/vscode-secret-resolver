import * as assert from "node:assert";

import { isOpRunCommand } from "../../src/processTree";

suite("isOpRunCommand", () => {
    test("matches `op run …` with the bare basename", () => {
        assert.strictEqual(isOpRunCommand("op run --env-file=/tmp/x -- java"), true);
        assert.strictEqual(isOpRunCommand("op run -- node app.js"), true);
    });

    test("matches `op run` with absolute or relative path", () => {
        assert.strictEqual(
            isOpRunCommand("/opt/homebrew/bin/op run --env-file=/tmp/x -- java"),
            true,
        );
        assert.strictEqual(
            isOpRunCommand("./node_modules/.bin/op run -- java"),
            true,
        );
    });

    test("rejects other commands that happen to start with op", () => {
        assert.strictEqual(isOpRunCommand("opentelemetry --foo"), false);
        assert.strictEqual(isOpRunCommand("op-helper run"), false);
        assert.strictEqual(isOpRunCommand("/usr/bin/operator run"), false);
    });

    test("rejects op with a different subcommand", () => {
        assert.strictEqual(isOpRunCommand("op signin"), false);
        assert.strictEqual(isOpRunCommand("op inject -i template.tpl"), false);
        assert.strictEqual(isOpRunCommand("/usr/bin/op item get foo"), false);
    });

    test("rejects bare `op` without a subcommand", () => {
        assert.strictEqual(isOpRunCommand("op"), false);
        assert.strictEqual(isOpRunCommand("/usr/bin/op"), false);
    });

    test("handles leading and trailing whitespace", () => {
        assert.strictEqual(isOpRunCommand("  op run -- java  "), true);
    });

    test("rejects empty input", () => {
        assert.strictEqual(isOpRunCommand(""), false);
        assert.strictEqual(isOpRunCommand("   "), false);
    });
});
