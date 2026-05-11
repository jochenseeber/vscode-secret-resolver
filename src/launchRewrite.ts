import { DebugProtocol } from "@vscode/debugprotocol"

/**
 * Type guard for a DAP `runInTerminal` request. Narrows `unknown` to
 * `RunInTerminalRequest` so callers can safely access `arguments.args` and
 * `arguments.env`.
 */
export function isRunInTerminalRequest(
    message: unknown,
): message is DebugProtocol.RunInTerminalRequest {
    if (typeof message !== "object" || message === null) {
        return false
    }

    const m = message as Partial<DebugProtocol.RunInTerminalRequest>
    const isMatch = m.type === "request"
        && m.command === "runInTerminal"
        && Array.isArray(m.arguments?.args)
    return isMatch
}

/**
 * Returns the runInTerminal argv that wraps the launch in
 * `op run --env-file=<envFilePath> -- <orig args>`. The env file is
 * expected to live for at least the duration of the spawned `op run`
 * invocation; cleanup is the caller's responsibility.
 */
export function buildOpRunArgs(
    opPath: string,
    envFilePath: string,
    args: readonly string[],
    account?: string,
): string[] {
    const result = [
        opPath,
        "run",
        ...(account !== undefined ? ["--account", account] : []),
        `--env-file=${envFilePath}`,
        "--",
        ...args,
    ]
    return result
}
