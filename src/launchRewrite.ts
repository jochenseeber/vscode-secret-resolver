import { DebugProtocol } from "@vscode/debugprotocol";

/**
 * Type guard for a DAP `runInTerminal` request. Narrows `unknown` to
 * `RunInTerminalRequest` so callers can safely access `arguments.args` and
 * `arguments.env`.
 */
export function isRunInTerminalRequest(
    message: unknown,
): message is DebugProtocol.RunInTerminalRequest {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const m = message as Partial<DebugProtocol.RunInTerminalRequest>;
    return m.type === "request"
        && m.command === "runInTerminal"
        && Array.isArray(m.arguments?.args);
}

/**
 * Returns a new args array with `[opPath, "run", "--"]` prepended.
 */
export function prependOpRun(
    args: readonly string[],
    opPath: string,
): string[] {
    return [opPath, "run", "--", ...args];
}
