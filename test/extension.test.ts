import * as assert from "node:assert"
import * as vscode from "vscode"

suite("Secret Resolver extension", () => {
    test("activates", async () => {
        const ext = vscode.extensions.getExtension(
            "jochenseeber.vscode-secret-resolver",
        )
        assert.ok(ext, "extension is installed")
        await ext.activate()
        assert.strictEqual(ext.isActive, true)
    })

    test("contributes the opPath configuration", () => {
        const value = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath")
        assert.strictEqual(typeof value, "string")
        assert.ok(value && value.length > 0)
    })

    test("registers the clearCache command", async () => {
        const ext = vscode.extensions.getExtension(
            "jochenseeber.vscode-secret-resolver",
        )
        await ext?.activate()
        const commands = await vscode.commands.getCommands(true)
        assert.ok(
            commands.includes("secretResolver.clearCache"),
            "secretResolver.clearCache should be registered",
        )
    })
})
