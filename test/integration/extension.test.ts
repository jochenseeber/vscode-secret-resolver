import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Secret Resolver extension", () => {
    test("activates", async () => {
        const ext = vscode.extensions.getExtension(
            "jochenseeber.vscode-secret-resolver",
        );
        assert.ok(ext, "extension is installed");
        await ext.activate();
        assert.strictEqual(ext.isActive, true);
    });

    test("contributes the opPath configuration", () => {
        const value = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath");
        assert.strictEqual(typeof value, "string");
        assert.ok(value && value.length > 0);
    });
});
