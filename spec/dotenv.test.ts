import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { EnvFileNotFoundError, formatDotenv, parseEnvFile } from "../src/dotenv"

async function withTempFile(
    contents: string,
    body: (filePath: string) => Promise<void>,
): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-dotenv-"))
    const file = path.join(dir, ".env")

    try {
        await fs.writeFile(file, contents, "utf8")
        await body(file)
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}

suite("parseEnvFile", () => {
    test("parses simple KEY=value lines", async () => {
        await withTempFile("FOO=bar\nBAZ=qux\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), {
                FOO: "bar",
                BAZ: "qux",
            })
        })
    })

    test("strips matched double or single quotes", async () => {
        await withTempFile(
            "DBL=\"hello world\"\nSGL='ello'\n",
            async (p) => {
                assert.deepStrictEqual(await parseEnvFile(p), {
                    DBL: "hello world",
                    SGL: "ello",
                })
            },
        )
    })

    test("preserves un-matched or absent quotes", async () => {
        await withTempFile("MIX=\"left\nUNQ=raw\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), {
                MIX: "\"left",
                UNQ: "raw",
            })
        })
    })

    test("honors a leading export prefix", async () => {
        await withTempFile("export FOO=bar\nexport BAZ='q'\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), {
                FOO: "bar",
                BAZ: "q",
            })
        })
    })

    test("ignores comments, blank lines, and lines without =", async () => {
        await withTempFile(
            "# comment\n\nFOO=bar\n  # indented comment\nbroken_no_eq\n",
            async (p) => {
                assert.deepStrictEqual(await parseEnvFile(p), { FOO: "bar" })
            },
        )
    })

    test("strips a leading UTF-8 BOM", async () => {
        await withTempFile("﻿FOO=bar\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), { FOO: "bar" })
        })
    })

    test("permits empty values", async () => {
        await withTempFile("EMPTY=\nQUOTED_EMPTY=\"\"\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), {
                EMPTY: "",
                QUOTED_EMPTY: "",
            })
        })
    })

    test("preserves inline # as part of the value", async () => {
        await withTempFile("URL=https://x.com/a#frag\n", async (p) => {
            assert.deepStrictEqual(await parseEnvFile(p), {
                URL: "https://x.com/a#frag",
            })
        })
    })

    test("throws EnvFileNotFoundError for missing files", async () => {
        const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`)
        await assert.rejects(
            parseEnvFile(missing),
            (err) => err instanceof EnvFileNotFoundError && err.path === missing,
        )
    })
})

suite("formatDotenv", () => {
    test("returns an empty string for an empty map", () => {
        assert.strictEqual(formatDotenv({}), "")
    })

    test("writes safe values unquoted with a trailing newline", () => {
        assert.strictEqual(
            formatDotenv({ FOO: "bar", PATH: "/usr/bin", URL: "https://x" }),
            "FOO=bar\nPATH=/usr/bin\nURL=https://x\n",
        )
    })

    test("double-quotes values containing whitespace, quotes, or backslashes", () => {
        assert.strictEqual(
            formatDotenv({
                SPACED: "with space",
                QUOTED: "she said \"hi\"",
                BACK: "a\\b",
            }),
            "SPACED=\"with space\"\n"
                + "QUOTED=\"she said \\\"hi\\\"\"\n"
                + "BACK=\"a\\\\b\"\n",
        )
    })

    test("escapes newlines, carriage returns, and dollar signs", () => {
        assert.strictEqual(
            formatDotenv({
                MULTI: "line1\nline2",
                CR: "x\ry",
                DOLLAR: "$SHELL",
            }),
            "MULTI=\"line1\\nline2\"\n"
                + "CR=\"x\\ry\"\n"
                + "DOLLAR=\"\\$SHELL\"\n",
        )
    })

    test("quotes empty values", () => {
        assert.strictEqual(formatDotenv({ EMPTY: "" }), "EMPTY=\"\"\n")
    })

    test("preserves unicode characters verbatim inside double quotes", () => {
        assert.strictEqual(
            formatDotenv({ GREETING: "héllo 🌍" }),
            "GREETING=\"héllo 🌍\"\n",
        )
    })

    test("round-trips through parseEnvFile for safe and quoted-safe values", async () => {
        const env = {
            PLAIN: "bar",
            URL: "https://example.com/path",
            SPACED: "value with spaces",
            EMPTY: "",
            HASH_FRAGMENT: "https://x.com/a#frag",
        }
        const text = formatDotenv(env)

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-dotenv-rt-"))
        const file = path.join(dir, ".env")

        try {
            await fs.writeFile(file, text, "utf8")
            assert.deepStrictEqual(await parseEnvFile(file), env)
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })
})
