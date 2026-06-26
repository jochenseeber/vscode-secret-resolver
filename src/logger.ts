/**
 * Minimal logging abstraction so pure modules can log without depending on
 * `vscode` or writing to the console directly. Production code wires an
 * `OutputChannelLogger` (see `vscodeAdapters.ts`); tests inject recorders.
 */
export interface Logger {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
}

/**
 * Fallback `Logger` used where no output channel is available (unit tests,
 * pure-module defaults).
 */
export class ConsoleLogger implements Logger {
    info(message: string): void {
        console.info(message)
    }

    warn(message: string): void {
        console.warn(message)
    }

    error(message: string): void {
        console.error(message)
    }
}
