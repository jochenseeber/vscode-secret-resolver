import * as assert from "node:assert"
import * as os from "node:os"
import * as path from "node:path"

import { promises as fs } from "node:fs"
import { OpCli } from "../src/opCli"

async function makeFakeOp(opts: {
    stdout: string
    argLogFile?: string
    envLogFile?: string
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-op-cli-"))
    const file = path.join(dir, "op")
    const logArgs = opts.argLogFile
        ? `echo "$@" >> ${JSON.stringify(opts.argLogFile)}`
        : ""
    const logEnv = opts.envLogFile
        ? `echo "\${OP_SERVICE_ACCOUNT_TOKEN:-unset}" >> ${JSON.stringify(opts.envLogFile)}`
        : ""

    await fs.writeFile(
        file,
        [
            "#!/usr/bin/env bash",
            logArgs,
            logEnv,
            `printf '%s' ${JSON.stringify(opts.stdout)}`,
        ].join("\n"),
        "utf8",
    )
    await fs.chmod(file, 0o755)

    return { path: file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

suite("OpCli", () => {
    test("adds --account and strips inherited service account token", async () => {
        if (process.platform === "win32") return

        const argLogFile = path.join(os.tmpdir(), `sr-op-cli-args-${Date.now()}.txt`)
        const envLogFile = path.join(os.tmpdir(), `sr-op-cli-env-${Date.now()}.txt`)
        const previousToken = process.env.OP_SERVICE_ACCOUNT_TOKEN
        const fake = await makeFakeOp({
            stdout: JSON.stringify({ ok: true }),
            argLogFile,
            envLogFile,
        })

        try {
            process.env.OP_SERVICE_ACCOUNT_TOKEN = "inherited-token"
            const result = await new OpCli(fake.path).execJson<{ ok: boolean }>(
                ["item", "list", "--format", "json"],
                {
                    account: "acct-123",
                    withoutServiceAccountToken: true,
                    parseErrorMessage: "fake op returned non-JSON output",
                },
            )

            assert.deepStrictEqual(result, { ok: true })
            assert.strictEqual(
                (await fs.readFile(argLogFile, "utf8")).trim(),
                "item list --account acct-123 --format json",
            )
            assert.strictEqual((await fs.readFile(envLogFile, "utf8")).trim(), "unset")
        }
        finally {
            if (previousToken === undefined) {
                delete process.env.OP_SERVICE_ACCOUNT_TOKEN
            }
            else {
                process.env.OP_SERVICE_ACCOUNT_TOKEN = previousToken
            }

            await fake.cleanup()
            await fs.rm(argLogFile, { force: true })
            await fs.rm(envLogFile, { force: true })
        }
    })
})
