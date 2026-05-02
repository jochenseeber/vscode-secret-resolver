import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { TempDirRegistry } from "./debugAdapterProxy"

export const TEMP_DIR_PREFIX = "secret-resolver-"

/**
 * In-process registry of temp dirs the trackers have created. Each entry is
 * an absolute path. The registry survives across debug sessions but lives in
 * the extension host process; it is the source of truth for `deactivate` and
 * signal-handler cleanup.
 */
export class InMemoryTempDirRegistry implements TempDirRegistry {
    private readonly dirs = new Set<string>()

    add(dir: string): void {
        this.dirs.add(dir)
    }

    remove(dir: string): void {
        this.dirs.delete(dir)
    }

    snapshot(): string[] {
        return [...this.dirs]
    }

    drain(): string[] {
        const snapshot = [...this.dirs]
        this.dirs.clear()
        return snapshot
    }
}

/**
 * Synchronous best-effort cleanup of every dir currently in the registry.
 * Safe to call from `deactivate` and `process.on('exit'|'SIGTERM'|'SIGINT')`.
 */
export function cleanupRegistry(registry: InMemoryTempDirRegistry): void {
    for (const dir of registry.drain()) {
        try {
            fs.rmSync(dir, { recursive: true, force: true })
        }
        catch {
            // best-effort
        }
    }
}

/**
 * Activation-time stale-dir sweep. Scans `os.tmpdir()` for
 * `secret-resolver-*` entries left behind by crashed VS Code instances and
 * removes those whose owning PID (recorded in a `.pid` file) is no longer
 * alive. Dirs without a `.pid` file are left alone (we can't tell ownership
 * safely). Wrapped end-to-end so a failing sweep never blocks activation.
 */
export function sweepStaleTempDirs(): void {
    try {
        const root = os.tmpdir()
        const entries = fs.readdirSync(root, { withFileTypes: true })

        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) {
                continue
            }

            const dir = path.join(root, entry.name)
            const pidPath = path.join(dir, ".pid")
            let pid: number | undefined

            try {
                const raw = fs.readFileSync(pidPath, "utf8").trim()
                const parsed = Number.parseInt(raw, 10)

                if (Number.isInteger(parsed) && parsed > 0) {
                    pid = parsed
                }
            }
            catch {
                continue
            }

            if (pid === undefined || isPidAlive(pid)) {
                continue
            }

            try {
                fs.rmSync(dir, { recursive: true, force: true })
            }
            catch {
                // best-effort
            }
        }
    }
    catch {
        // best-effort
    }
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code

        if (code === "EPERM") {
            return true
        }

        return false
    }
}
