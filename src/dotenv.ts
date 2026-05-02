import { promises as fs } from "node:fs"

import type { StringEnvMap } from "./envHelpers"

/**
 * Thrown by `parseEnvFile` when the file does not exist. The caller can
 * catch this distinctly from other I/O errors (permission, etc.) and decide
 * whether to abort or warn-and-continue.
 */
export class EnvFileNotFoundError extends Error {
    readonly path: string

    constructor(path: string) {
        super(`envFile not found: ${path}`)
        this.name = "EnvFileNotFoundError"
        this.path = path
    }
}

/**
 * Minimal dotenv-style parser. Supports `KEY=value`, optional matched-pair
 * surrounding `"`/`'` quotes (stripped), optional leading `export `,
 * `# comment` and blank lines, and a leading UTF-8 BOM. Does not perform
 * variable expansion. Inline `#` after a value is preserved as part of the
 * value (matches VS Code's tolerant behavior).
 */
export async function parseEnvFile(path: string): Promise<StringEnvMap> {
    let content: string

    try {
        content = await fs.readFile(path, "utf8")
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new EnvFileNotFoundError(path)
        }

        throw err
    }

    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1)
    }

    const out: StringEnvMap = {}

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trimStart()

        if (line.length === 0 || line.startsWith("#")) {
            continue
        }

        const stripped = line.startsWith("export ") ? line.slice(7) : line
        const eq = stripped.indexOf("=")

        if (eq <= 0) {
            continue
        }

        const key = stripped.slice(0, eq).trim()

        if (key.length === 0) {
            continue
        }

        let value = stripped.slice(eq + 1)
        value = stripValueQuotes(value)
        out[key] = value
    }

    return out
}

function stripValueQuotes(value: string): string {
    if (value.length < 2) {
        return value
    }

    const first = value[0]
    const last = value[value.length - 1]

    if ((first === "\"" || first === "'") && first === last) {
        return value.slice(1, -1)
    }

    return value
}

const SAFE_UNQUOTED = /^[A-Za-z0-9_./:@+\-]+$/

/**
 * Serializes an env map to a dotenv-formatted string accepted by `op run
 * --env-file`. Values made up solely of safe ASCII characters are written
 * unquoted; everything else is double-quoted with backslash escapes for
 * `\`, `"`, `$`, `\n`, and `\r`. Output ends with a trailing newline when
 * non-empty.
 */
export function formatDotenv(env: StringEnvMap): string {
    const lines: string[] = []

    for (const [key, value] of Object.entries(env)) {
        lines.push(`${key}=${formatValue(value)}`)
    }

    return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function formatValue(value: string): string {
    if (value.length > 0 && SAFE_UNQUOTED.test(value)) {
        return value
    }

    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\$/g, "\\$")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")

    return `"${escaped}"`
}
