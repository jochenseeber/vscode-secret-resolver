import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const TEMP_DIR_PREFIX = "secret-resolver-"

/**
 * Master registry of temp directories the trackers have created. Owned by
 * `extension.ts`; the registry survives across debug sessions and lets the
 * extension drive cleanup from `deactivate`, signal handlers, and the
 * activation-time stale-directory sweep.
 */
export interface TempDirRegistry {
    add(directory: string): void
    remove(directory: string): void
}

/**
 * In-process registry of temp directories the trackers have created. Each entry is
 * an absolute path. The registry survives across debug sessions but lives in
 * the extension host process; it is the source of truth for `deactivate` and
 * signal-handler cleanup.
 */
export class InMemoryTempDirRegistry implements TempDirRegistry {
    private readonly directories = new Set<string>()

    add(directory: string): void {
        this.directories.add(directory)
    }

    remove(directory: string): void {
        this.directories.delete(directory)
    }

    snapshot(): string[] {
        const directories = [...this.directories]
        return directories
    }

    drain(): string[] {
        const snapshot = [...this.directories]
        this.directories.clear()
        return snapshot
    }

    /**
     * Synchronous best-effort cleanup of every directory currently in the
     * registry. Safe to call from `deactivate` and
     * `process.on('exit'|'SIGTERM'|'SIGINT')`.
     */
    cleanup(): void {
        for (const directory of this.drain()) {
            InMemoryTempDirRegistry.removeDirectoryQuietly(directory)
        }
    }

    /**
     * Synchronous best-effort recursive removal of `directory`. Never throws;
     * shared by the tracker, the terminal env rewriter, and the registry so
     * the swallow-and-continue removal lives in one place.
     */
    static removeDirectoryQuietly(directory: string): void {
        try {
            fs.rmSync(directory, { recursive: true, force: true })
        }
        catch {
            // best-effort
        }
    }

    /**
     * Activation-time stale-directory sweep. Scans `os.tmpdir()` for
     * `secret-resolver-*` entries left behind by crashed VS Code instances and
     * removes those whose owning PID (recorded in a `.pid` file) is no longer
     * alive. Dirs without a `.pid` file are left alone (we can't tell ownership
     * safely). Wrapped end-to-end so a failing sweep never blocks activation.
     */
    static sweepStale(): void {
        try {
            const root = os.tmpdir()
            const entries = fs.readdirSync(root, { withFileTypes: true })

            for (const entry of entries) {
                if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIR_PREFIX)) {
                    continue
                }

                const directory = path.join(root, entry.name)
                const pidPath = path.join(directory, ".pid")
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

                if (pid === undefined || InMemoryTempDirRegistry.isPidAlive(pid)) {
                    continue
                }

                InMemoryTempDirRegistry.removeDirectoryQuietly(directory)
            }
        }
        catch {
            // best-effort
        }
    }

    private static isPidAlive(pid: number): boolean {
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
}
