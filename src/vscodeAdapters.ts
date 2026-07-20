import * as vscode from "vscode"

import type { Logger } from "./logger"
import type { ResolverSettings, ResolverSettingsReader } from "./resolveLaunchConfig"
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

/**
 * `ResolverSettingsReader` backed by the `secretResolver.*` VS Code settings.
 * Read fresh on every launch, scoped to the launch folder so per-folder
 * (project) settings apply on top of workspace and user settings. Blank
 * settings are normalized to `undefined` so an unset default and an explicitly
 * empty one behave identically.
 */
export class WorkspaceResolverSettingsReader implements ResolverSettingsReader {
    read(workspacePath: string | undefined): ResolverSettings {
        const resource = workspacePath !== undefined ? vscode.Uri.file(workspacePath) : undefined
        const config = vscode.workspace.getConfiguration("secretResolver", resource)
        const settings: ResolverSettings = {
            accountId: WorkspaceResolverSettingsReader.readSetting(config, "accountId"),
            accountGitConfig: WorkspaceResolverSettingsReader.readSetting(config, "accountGitConfig"),
            accountEmail: WorkspaceResolverSettingsReader.readSetting(config, "accountEmail"),
            tokenTag: WorkspaceResolverSettingsReader.readSetting(config, "tokenTag"),
            signalOnStop: WorkspaceResolverSettingsReader.readSetting(config, "signalOnStop"),
            sanitizeVars: WorkspaceResolverSettingsReader.readSetting(config, "sanitizeVars"),
        }
        return settings
    }

    private static readSetting(
        config: vscode.WorkspaceConfiguration,
        key: string,
    ): string | undefined {
        const raw = config.get<string>(key, "")
        const trimmed = raw.trim()
        const value = trimmed === "" ? undefined : trimmed
        return value
    }
}
