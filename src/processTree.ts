import { execFile } from "node:child_process"
import { promisify } from "node:util"

import pidtree from "pidtree"

import type { Logger } from "./logger"

const execFileAsync = promisify(execFile)

/**
 * Enumerates a process tree for signal-on-stop. `getProcessTree` returns
 * every PID in the tree rooted at `rootPid`, including the root itself, in
 * breadth-first order, or an empty array if the root is already gone or
 * enumeration fails. The stop-signal controller uses this to enumerate the
 * launched process and all of its descendants, then signals every descendant
 * (never the root).
 */
export interface ProcessTreeReader {
    getProcessTree(rootPid: number): Promise<number[]>
}

/**
 * `ProcessTreeReader` backed by the `pidtree` package (`{ root: true }`),
 * which shells out to `ps` on macOS / BSD and reads `/proc` on Linux to
 * enumerate the tree. Returns an empty array on any failure.
 */
export class PidtreeProcessTreeReader implements ProcessTreeReader {
    constructor(private readonly logger: Logger) {}

    async getProcessTree(rootPid: number): Promise<number[]> {
        try {
            const pids = await pidtree(rootPid, { root: true })
            return pids
        }
        catch (err) {
            this.logger.error(
                `pidtree(${rootPid}) failed: ${(err as Error).message}`,
            )
            const empty: number[] = []
            return empty
        }
    }
}

/**
 * Locates a live process by a unique substring of its command line. Used as
 * the signal-on-stop fallback when the `runInTerminal` response carries no
 * PID (external terminals): the `op run` wrap contains the per-launch temp
 * directory name, which is unique, so matching it finds the wrapper process.
 */
export interface ProcessFinder {
    findProcessIdByCommandLineMarker(marker: string): Promise<number | null>
}

/**
 * `ProcessFinder` backed by `pgrep -f <marker>` (macOS and Linux). Returns
 * the first matching PID, `null` when nothing matches or `pgrep` fails. The
 * marker is used as-is in `pgrep`'s regex match, so callers must pass markers
 * without regex metacharacters (the `secret-resolver-XXXXXX` temp-dir names
 * are alphanumeric plus `-`).
 */
export class PgrepProcessFinder implements ProcessFinder {
    constructor(
        private readonly logger: Logger,
        private readonly pgrepPath: string = "pgrep",
    ) {}

    async findProcessIdByCommandLineMarker(marker: string): Promise<number | null> {
        let stdout: string

        try {
            const result = await execFileAsync(
                this.pgrepPath,
                ["-f", marker],
                { encoding: "utf8" },
            )
            stdout = result.stdout
        }
        catch (err) {
            const error = err as Error & { code?: string | number }

            // pgrep exits 1 when nothing matches — an expected outcome, not
            // an error. Everything else (ENOENT, exit 2, ...) is logged.
            if (error.code !== 1) {
                this.logger.error(
                    `${this.pgrepPath} -f ${marker} failed: ${error.message}`,
                )
            }

            return null
        }

        const processIds = stdout
            .split("\n")
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((processId) => Number.isInteger(processId) && processId > 0)

        if (processIds.length === 0) {
            return null
        }

        if (processIds.length > 1) {
            this.logger.warn(
                `${this.pgrepPath} -f ${marker} matched ${processIds.length} processes; using PID ${processIds[0]}`,
            )
        }

        const processId = processIds[0]
        return processId
    }
}
