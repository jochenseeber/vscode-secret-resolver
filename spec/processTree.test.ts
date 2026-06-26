import * as assert from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { Logger } from "../src/logger"
import { PgrepProcessFinder } from "../src/processTree"

class RecordingLogger implements Logger {
    readonly infos: string[] = []
    readonly warnings: string[] = []
    readonly errors: string[] = []

    info(message: string): void {
        this.infos.push(message)
    }

    warn(message: string): void {
        this.warnings.push(message)
    }

    error(message: string): void {
        this.errors.push(message)
    }
}

/**
 * Fake `pgrep` binary. Prints `stdout` and exits 0, or exits with `exitCode`
 * when set.
 */
async function makeFakePgrep(options: {
    stdout?: string
    exitCode?: number
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr-fake-pgrep-"))
    const file = path.join(dir, "pgrep")

    const body = options.exitCode !== undefined
        ? `#!/usr/bin/env bash\nexit ${options.exitCode}`
        : `#!/usr/bin/env bash\nprintf '%b' ${JSON.stringify(options.stdout ?? "")}`

    await fs.writeFile(file, body, "utf8")
    await fs.chmod(file, 0o755)
    return { path: file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

suite("PgrepProcessFinder", () => {
    test("returns the single matching PID", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakePgrep({ stdout: "4242\n" })

        try {
            const logger = new RecordingLogger()
            const finder = new PgrepProcessFinder(logger, fake.path)
            const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
            assert.strictEqual(pid, 4242)
            assert.deepStrictEqual(logger.warnings, [])
            assert.deepStrictEqual(logger.errors, [])
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns the first PID and warns when several match", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakePgrep({ stdout: "100\n200\n300\n" })

        try {
            const logger = new RecordingLogger()
            const finder = new PgrepProcessFinder(logger, fake.path)
            const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
            assert.strictEqual(pid, 100)
            assert.strictEqual(logger.warnings.length, 1)
            assert.match(logger.warnings[0], /matched 3 processes/)
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns null without logging when pgrep matches nothing (exit 1)", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakePgrep({ exitCode: 1 })

        try {
            const logger = new RecordingLogger()
            const finder = new PgrepProcessFinder(logger, fake.path)
            const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
            assert.strictEqual(pid, null)
            assert.deepStrictEqual(logger.errors, [])
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns null and logs on other pgrep failures (exit 2)", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakePgrep({ exitCode: 2 })

        try {
            const logger = new RecordingLogger()
            const finder = new PgrepProcessFinder(logger, fake.path)
            const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
            assert.strictEqual(pid, null)
            assert.strictEqual(logger.errors.length, 1)
        }
        finally {
            await fake.cleanup()
        }
    })

    test("returns null and logs when the pgrep binary does not exist", async () => {
        const logger = new RecordingLogger()
        const finder = new PgrepProcessFinder(logger, "/no/such/pgrep")
        const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
        assert.strictEqual(pid, null)
        assert.strictEqual(logger.errors.length, 1)
    })

    test("returns null for unparsable output", async () => {
        if (process.platform === "win32") return

        const fake = await makeFakePgrep({ stdout: "garbage\n" })

        try {
            const logger = new RecordingLogger()
            const finder = new PgrepProcessFinder(logger, fake.path)
            const pid = await finder.findProcessIdByCommandLineMarker("secret-resolver-abc123")
            assert.strictEqual(pid, null)
        }
        finally {
            await fake.cleanup()
        }
    })
})
