import { promises as fs, writeFileSync } from "node:fs"

/**
 * Thrown by `DotenvFile.parseFile` when the file does not exist. The caller can
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
 * Thrown by `DotenvFile.format` when an env key cannot round-trip through the
 * dotenv format (empty, contains `=` or whitespace, or starts with `#`).
 * Rejecting such keys keeps a crafted key from injecting extra lines into the
 * written env file.
 */
export class InvalidEnvKeyError extends Error {
    readonly key: string

    constructor(key: string) {
        super(`invalid env key: ${JSON.stringify(key)}`)
        this.name = "InvalidEnvKeyError"
        this.key = key
    }
}

/**
 * Reads and writes minimal dotenv files for a single path (held as instance
 * state). `parseFile` reads and parses; `write` formats and writes. The pure
 * `parse` / `format` operations are exposed as static methods.
 */
export class DotenvFile {
    private static readonly SAFE_UNQUOTED = /^[A-Za-z0-9_./:@+\-]+$/
    private static readonly VALID_KEY = /^[^\s#=][^\s=]*$/

    constructor(private readonly path: string) {}

    /**
     * Reads and parses the file at `this.path`. Throws `EnvFileNotFoundError`
     * for ENOENT so callers can warn and continue; rethrows other I/O errors.
     */
    async parseFile(): Promise<Record<string, string>> {
        let content: string

        try {
            content = await fs.readFile(this.path, "utf8")
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                throw new EnvFileNotFoundError(this.path)
            }

            throw err
        }

        const parsed = DotenvFile.parse(content)
        return parsed
    }

    /**
     * Formats `env` and writes it to `this.path`. Synchronous so it fits the
     * synchronous `runInTerminal` rewrite hook. Defaults to mode `0o600` so a
     * secret env file is never written world-readable.
     */
    write(env: Record<string, string>, mode = 0o600): void {
        writeFileSync(this.path, DotenvFile.format(env), { mode })
    }

    /**
     * Minimal dotenv-style parser. Supports `KEY=value`, optional matched-pair
     * surrounding `"`/`'` quotes (stripped), optional leading `export `,
     * `# comment` and blank lines, and a leading UTF-8 BOM. Does not perform
     * variable expansion. Inline `#` after a value is preserved as part of the
     * value (matches VS Code's tolerant behavior).
     */
    static parse(text: string): Record<string, string> {
        let content = text

        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1)
        }

        const out: Record<string, string> = {}

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
            value = DotenvFile.stripValueQuotes(value)
            out[key] = value
        }

        return out
    }

    /**
     * Serializes an env map to a dotenv-formatted string accepted by `op run
     * --env-file`. Values made up solely of safe ASCII characters are written
     * unquoted; everything else is double-quoted with backslash escapes for
     * `\`, `"`, `$`, `\n`, and `\r`. Output ends with a trailing newline when
     * non-empty. Throws `InvalidEnvKeyError` for keys that cannot round-trip
     * through the format.
     */
    static format(env: Record<string, string>): string {
        const lines: string[] = []

        for (const [key, value] of Object.entries(env)) {
            if (!DotenvFile.VALID_KEY.test(key)) {
                throw new InvalidEnvKeyError(key)
            }

            lines.push(`${key}=${DotenvFile.formatValue(value)}`)
        }

        const result = lines.length > 0 ? `${lines.join("\n")}\n` : ""
        return result
    }

    private static stripValueQuotes(value: string): string {
        if (value.length < 2) {
            return value
        }

        const first = value[0]
        const last = value[value.length - 1]

        if ((first === "\"" || first === "'") && first === last) {
            const unquoted = value.slice(1, -1)
            return unquoted
        }

        return value
    }

    private static formatValue(value: string): string {
        if (value.length > 0 && DotenvFile.SAFE_UNQUOTED.test(value)) {
            return value
        }

        const escaped = value
            .replace(/\\/g, "\\\\")
            .replace(/"/g, "\\\"")
            .replace(/\$/g, "\\$")
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")

        const quoted = `"${escaped}"`
        return quoted
    }
}
