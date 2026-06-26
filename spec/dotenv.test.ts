import * as assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"

import { DotenvFile, EnvFileNotFoundError, InvalidEnvKeyError } from "../src/dotenv"

import { promises as fs } from "node:fs"

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

suite("DotenvFile.parseFile", () => {
    test("parses simple KEY=value lines", async () => {
        await withTempFile("FOO=bar\nBAZ=qux\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                FOO: "bar",
                BAZ: "qux",
            })
        })
    })

    test("strips matched double or single quotes", async () => {
        await withTempFile(
            "DBL=\"hello world\"\nSGL='ello'\n", // cspell:disable-line
            async (p) => {
                assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                    DBL: "hello world",
                    SGL: "ello", // cspell:disable-line
                })
            },
        )
    })

    test("preserves un-matched or absent quotes", async () => {
        await withTempFile("MIX=\"left\nUNQ=raw\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                MIX: "\"left",
                UNQ: "raw",
            })
        })
    })

    test("honors a leading export prefix", async () => {
        await withTempFile("export FOO=bar\nexport BAZ='q'\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                FOO: "bar",
                BAZ: "q",
            })
        })
    })

    test("ignores comments, blank lines, and lines without =", async () => {
        await withTempFile(
            "# comment\n\nFOO=bar\n  # indented comment\nbroken_no_eq\n",
            async (p) => {
                assert.deepStrictEqual(await new DotenvFile(p).parseFile(), { FOO: "bar" })
            },
        )
    })

    test("strips a leading UTF-8 BOM", async () => {
        await withTempFile("﻿FOO=bar\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), { FOO: "bar" })
        })
    })

    test("permits empty values", async () => {
        await withTempFile("EMPTY=\nQUOTED_EMPTY=\"\"\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                EMPTY: "",
                QUOTED_EMPTY: "",
            })
        })
    })

    test("preserves inline # as part of the value", async () => {
        await withTempFile("URL=https://x.com/a#frag\n", async (p) => {
            assert.deepStrictEqual(await new DotenvFile(p).parseFile(), {
                URL: "https://x.com/a#frag",
            })
        })
    })

    test("throws EnvFileNotFoundError for missing files", async () => {
        const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`)
        await assert.rejects(
            new DotenvFile(missing).parseFile(),
            (err) => err instanceof EnvFileNotFoundError && err.path === missing,
        )
    })
})

suite("DotenvFile.parse", () => {
    test("parses text without touching the filesystem", () => {
        assert.deepStrictEqual(
            DotenvFile.parse("﻿export FOO=bar\n# comment\nDBL=\"hello world\"\n"),
            { FOO: "bar", DBL: "hello world" },
        )
    })
})

suite("DotenvFile.format", () => {
    test("returns an empty string for an empty map", () => {
        assert.strictEqual(DotenvFile.format({}), "")
    })

    test("writes safe values unquoted with a trailing newline", () => {
        assert.strictEqual(
            DotenvFile.format({ FOO: "bar", PATH: "/usr/bin", URL: "https://x" }),
            "FOO=bar\nPATH=/usr/bin\nURL=https://x\n",
        )
    })

    test("double-quotes values containing whitespace, quotes, or backslashes", () => {
        assert.strictEqual(
            DotenvFile.format({
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
            DotenvFile.format({
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
        assert.strictEqual(DotenvFile.format({ EMPTY: "" }), "EMPTY=\"\"\n")
    })

    test("throws InvalidEnvKeyError for keys that cannot round-trip", () => {
        assert.throws(() => DotenvFile.format({ "BAD=KEY": "v" }), InvalidEnvKeyError)
        assert.throws(() => DotenvFile.format({ "BAD\nKEY": "v" }), InvalidEnvKeyError)
        assert.throws(() => DotenvFile.format({ "BAD KEY": "v" }), InvalidEnvKeyError)
        assert.throws(() => DotenvFile.format({ "#BADKEY": "v" }), InvalidEnvKeyError)
        assert.throws(() => DotenvFile.format({ "": "v" }), InvalidEnvKeyError)
    })

    test("accepts keys with dots, dashes, and mid-string hashes", () => {
        assert.strictEqual(
            DotenvFile.format({ "MY.KEY": "a", "MY-KEY": "b", "MY#KEY": "c" }),
            "MY.KEY=a\nMY-KEY=b\nMY#KEY=c\n",
        )
    })

    test("preserves unicode characters verbatim inside double quotes", () => {
        assert.strictEqual(
            DotenvFile.format({ GREETING: "héllo 🌍" }), // cspell:disable-line
            "GREETING=\"héllo 🌍\"\n", // cspell:disable-line
        )
    })

    test("round-trips through parseFile for safe and quoted-safe values", async () => {
        const env = {
            PLAIN: "bar",
            URL: "https://example.com/path",
            SPACED: "value with spaces",
            EMPTY: "",
            HASH_FRAGMENT: "https://x.com/a#frag",
        }
        const text = DotenvFile.format(env)

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-dotenv-rt-"))
        const file = path.join(dir, ".env")

        try {
            await fs.writeFile(file, text, "utf8")
            assert.deepStrictEqual(await new DotenvFile(file).parseFile(), env)
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })
})

suite("DotenvFile.write", () => {
    test("writes formatted env with 0o600 mode and round-trips via parseFile", async () => {
        if (process.platform === "win32") {
            return
        }

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-dotenv-write-"))
        const file = path.join(dir, ".env")

        try {
            const env = { FOO: "bar", SPACED: "with space" }
            new DotenvFile(file).write(env)

            const stat = await fs.stat(file)
            assert.strictEqual(stat.mode & 0o777, 0o600)
            assert.deepStrictEqual(await new DotenvFile(file).parseFile(), env)
        }
        finally {
            await fs.rm(dir, { recursive: true, force: true })
        }
    })
})
