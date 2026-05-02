import * as vscode from "vscode"

import { parseEnvFile } from "./dotenv"
import { DefaultOpInjectRunner, type OpInjectRunner } from "./opInject"
import { resolveLaunchConfig } from "./resolveLaunchConfig"
import type { SecretCache } from "./secretCache"

/**
 * VS Code-aware wrapper around `resolveLaunchConfig`. Bridges
 * `CancellationToken` to `AbortSignal`, reads `secretResolver.opPath` from
 * configuration, and routes user-facing messages through `vscode.window`.
 */
export class SecretDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    readonly #cache: SecretCache
    readonly #runner: OpInjectRunner

    constructor(cache: SecretCache, runner: OpInjectRunner) {
        this.#cache = cache
        this.#runner = runner
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const controller = new AbortController()
        const subscription = token?.onCancellationRequested(() => {
            controller.abort()
        })

        try {
            return await resolveLaunchConfig(
                debugConfiguration,
                {
                    cache: this.#cache,
                    runner: this.#runner,
                    parseEnvFile,
                    getOpPath: () =>
                        vscode.workspace
                            .getConfiguration("secretResolver")
                            .get<string>("opPath", "op"),
                    showError: (m) => {
                        void vscode.window.showErrorMessage(m)
                    },
                    showWarning: (m) => {
                        void vscode.window.showWarningMessage(m)
                    },
                },
                controller.signal,
            )
        }
        finally {
            subscription?.dispose()
        }
    }
}

export function createDefaultProvider(
    cache: SecretCache,
): SecretDebugConfigurationProvider {
    return new SecretDebugConfigurationProvider(
        cache,
        new DefaultOpInjectRunner(),
    )
}
