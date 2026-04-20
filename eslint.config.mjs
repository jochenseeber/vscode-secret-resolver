import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "build/",
            "node_modules/",
            ".vscode-test/",
            ".playwright-mcp/",
            "pkg/",
            "*.vsix",
        ],
    },
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
        plugins: {
            "@stylistic": stylistic,
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "*", next: "block-like" },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
        },
    },
);
