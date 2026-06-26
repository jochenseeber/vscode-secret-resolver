import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export class GitEmailNotFoundError extends Error {
    constructor(message?: string) {
        super(message ?? "Could not read user.email from git config.")
        this.name = "GitEmailNotFoundError"
    }
}

export class GitRunner {
    constructor(readonly gitPath: string = "git") {}

    /**
     * Reads `user.email` from git config at `cwd` by running
     * `git -C <cwd> config --get user.email`.
     * Throws `GitEmailNotFoundError` if git is not installed, the email is
     * not set, or the command fails.
     */
    async getEmail(cwd: string, signal?: AbortSignal): Promise<string> {
        let stdout: string

        try {
            const result = await execFileAsync(
                this.gitPath,
                ["-C", cwd, "config", "--get", "user.email"],
                { signal, encoding: "utf8" },
            )
            stdout = result.stdout
        }
        catch (err) {
            const error = err as NodeJS.ErrnoException & { code?: string | number }

            if (error.code === "ENOENT") {
                throw new GitEmailNotFoundError(
                    "git is not installed or not on PATH.",
                )
            }

            if (error.name === "AbortError" || error.code === "ABORT_ERR") {
                throw error
            }

            throw new GitEmailNotFoundError(
                `git config --get user.email failed: ${error.message}`,
            )
        }

        const email = stdout.trim()

        if (email === "") {
            throw new GitEmailNotFoundError()
        }

        return email
    }
}
