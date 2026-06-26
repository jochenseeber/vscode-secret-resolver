/**
 * User-facing notification abstraction. Implemented by `WindowUserNotifier`
 * (see `vscodeAdapters.ts`) via `vscode.window` message popups; tests inject
 * recorders. Distinct from `Logger`: notifications interrupt the user, logs
 * do not.
 */
export interface UserNotifier {
    showError(message: string): void
    showWarning(message: string): void
}
