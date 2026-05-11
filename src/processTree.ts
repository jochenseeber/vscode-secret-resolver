import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import { promisify } from "node:util"

import pidtree from "pidtree"

const execFileAsync = promisify(execFile)

export interface ProcessInfo {
    pid: number
    ppid: number
    /** Full command with args (e.g. `op run --env-file=… -- java …`). */
    command: string
}

/**
 * Returns the process tree rooted at `rootPid`: the root itself first
 * (when still alive) followed by its descendants in breadth-first order.
 * Each entry carries `pid`, `ppid`, and `command` so callers can navigate
 * the parent → child structure (e.g. find direct children of an `op run`
 * wrapper). The default implementation delegates to the `pidtree` package
 * (with `{ root: true, advanced: true }`) and looks up commands via `/proc`
 * on Linux or `ps` on macOS / BSD.
 */
export type GetProcessTreeFn = (rootPid: number) => Promise<ProcessInfo[]>

/**
 * True when the command line is an `op run` invocation (e.g. plain `op run …`
 * or `/opt/homebrew/bin/op run …`). Used by the tracker to locate the
 * wrapper process whose direct children should receive the stop signal.
 */
export function isOpRunCommand(command: string): boolean {
    const trimmed = command.trim()

    if (trimmed.length === 0) {
        return false
    }

    const parts = trimmed.split(/\s+/)

    if (parts.length < 2) {
        return false
    }

    const argv0 = parts[0]
    const argv1 = parts[1]
    const basename = argv0.includes("/")
        ? argv0.slice(argv0.lastIndexOf("/") + 1)
        : argv0

    const isOpRun = basename === "op" && argv1 === "run"
    return isOpRun
}

// ---------------------------------------------------------------------------
// PsRunner
// ---------------------------------------------------------------------------

/**
 * Wraps the BSD / macOS `ps` command to read command lines for a set of PIDs
 * in one invocation.
 */
export class PsRunner {
    constructor(readonly psPath: string = "ps") {}

    /**
     * Returns a map of `pid → commandLine` for the given PIDs.
     * Uses a single `ps -p <pid> ... -o pid=,command=` call.
     * Returns an empty map on any failure (process already exited, etc.).
     */
    async getCommands(
        pids: readonly number[],
        signal?: AbortSignal,
    ): Promise<Map<number, string>> {
        const args: string[] = []

        for (const pid of pids) {
            args.push("-p", String(pid))
        }

        args.push("-o", "pid=,command=")

        let stdout: string

        try {
            const result = await execFileAsync(this.psPath, args, {
                timeout: 5_000,
                ...(signal !== undefined ? { signal } : {}),
            })
            stdout = result.stdout
        }
        catch (err) {
            console.error(
                `[secret-resolver] ps lookup failed: ${(err as Error).message}`,
            )
            return new Map()
        }

        const out = new Map<number, string>()

        for (const rawLine of stdout.split("\n")) {
            const line = rawLine.trimStart()

            if (line.length === 0) {
                continue
            }

            const match = line.match(/^(\d+)\s+(.*)$/)

            if (match === null) {
                continue
            }

            out.set(Number(match[1]), match[2].trim())
        }

        return out
    }
}

// ---------------------------------------------------------------------------
// createDefaultGetProcessTree
// ---------------------------------------------------------------------------

/**
 * Returns a `GetProcessTreeFn` that uses the `pidtree` package to enumerate
 * processes and `/proc/<pid>/cmdline` (Linux) or `psRunner` (macOS / BSD) to
 * resolve command lines. Returns an empty array on any failure.
 */
export function createDefaultGetProcessTree(
    psRunner: PsRunner = new PsRunner(),
): GetProcessTreeFn {
    return async (rootPid) => {
        let entries: { pid: number; ppid: number }[]

        try {
            entries = await pidtree(rootPid, { root: true, advanced: true })
        }
        catch (err) {
            console.error(
                `[secret-resolver] pidtree(${rootPid}) failed: ${(err as Error).message}`,
            )
            return []
        }

        if (entries.length === 0) {
            return []
        }

        const pids = entries.map((e) => e.pid)
        const commandsByPid = process.platform === "linux"
            ? await readCommandsFromProc(pids)
            : await psRunner.getCommands(pids)

        const result = entries.map((e) => ({
            pid: e.pid,
            ppid: e.ppid,
            command: commandsByPid.get(e.pid) ?? "",
        }))
        return result
    }
}

async function readCommandsFromProc(
    pids: number[],
): Promise<Map<number, string>> {
    const out = new Map<number, string>()

    for (const pid of pids) {
        let cmdline: string

        try {
            cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8")
        }
        catch {
            // Process exited between pidtree and this read. Skip silently.
            continue
        }

        // /proc/<pid>/cmdline is NUL-separated, with a trailing NUL.
        const args = cmdline.split("\x00").filter((part) => part.length > 0)
        out.set(pid, args.join(" "))
    }

    return out
}
