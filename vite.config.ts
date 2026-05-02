import { builtinModules } from "node:module"
import { defineConfig } from "vitest/config"

export default defineConfig(({ mode }) => ({
    build: {
        lib: {
            entry: "src/extension.ts",
            formats: ["cjs"],
            fileName: () => "extension.js",
        },
        srcDir: "src",
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: {
            external: ["vscode", /^node:/, ...builtinModules],
        },
        target: "node20",
        sourcemap: true,
        minify: mode === "production",
    },
    test: {
        globals: true,
        include: ["spec/**/*.test.ts"],
    },
}))
