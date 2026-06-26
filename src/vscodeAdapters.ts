import * as vscode from "vscode"

import type { Logger } from "./logger"
import type { UserNotifier } from "./userNotifier"

/**
 * `Logger` backed by a `vscode.LogOutputChannel`. The extension creates one
 * channel on activation and injects it everywhere logging is needed.
 */
export class OutputChannelLogger implements Logger {
    constructor(private readonly channel: vscode.LogOutputChannel) {}

    info(message: string): void {
        this.channel.info(message)
    }

    warn(message: string): void {
        this.channel.warn(message)
    }

    error(message: string): void {
        this.channel.error(message)
    }
}

/**
 * `UserNotifier` backed by `vscode.window` message popups.
 */
export class WindowUserNotifier implements UserNotifier {
    showError(message: string): void {
        void vscode.window.showErrorMessage(message)
    }

    showWarning(message: string): void {
        void vscode.window.showWarningMessage(message)
    }
}
