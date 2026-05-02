import { includeIgnoreFile } from "@eslint/compat"
import stylistic from "@stylistic/eslint-plugin"
import tseslint from "typescript-eslint"

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = dirname(fileURLToPath(import.meta.url))
const GITIGNORE = resolve(ROOT, ".gitignore")

const gitignoreConfig = existsSync(GITIGNORE)
    ? includeIgnoreFile(GITIGNORE)
    : { ignores: [] }

export default tseslint.config(
    gitignoreConfig,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.ts", "spec/**/*.ts", "scripts/**/*.ts"],
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
            "@stylistic/semi": ["error", "never"],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "*", next: "block-like" },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
        },
    },
)
