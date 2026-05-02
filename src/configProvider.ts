import * as vscode from "vscode"

import { type GitEmailStore, resolveAccountForEmail, resolveAccountForGitConfig } from "./accountResolver"
import { parseEnvFile } from "./dotenv"
import { DefaultOpInjectRunner, type OpInjectRunner } from "./opInject"
import { resolveLaunchConfig } from "./resolveLaunchConfig"
import type { SecretCache } from "./secretCache"
import { resolveTokenForTag } from "./tokenResolver"

const GIT_EMAILS_KEY = "secretResolver.gitEmails"

class WorkspaceStateGitEmailStore implements GitEmailStore {
    constructor(private readonly ws: vscode.Memento) {}

    get(dir: string): string | undefined {
        return this.ws.get<Record<string, string>>(GIT_EMAILS_KEY)?.[dir]
    }

    set(dir: string, email: string): void {
        const current = this.ws.get<Record<string, string>>(GIT_EMAILS_KEY) ?? {}
        void this.ws.update(GIT_EMAILS_KEY, { ...current, [dir]: email })
    }

    clear(): void {
        void this.ws.update(GIT_EMAILS_KEY, undefined)
    }
}

/**
 * VS Code-aware wrapper around `resolveLaunchConfig`. Bridges
 * `CancellationToken` to `AbortSignal`, reads `secretResolver.opPath` from
 * configuration, and routes user messages through `vscode.window`.
 */
export class SecretDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    readonly #cache: SecretCache
    readonly #runner: OpInjectRunner
    readonly #gitEmailStore: GitEmailStore

    constructor(cache: SecretCache, runner: OpInjectRunner, gitEmailStore: GitEmailStore) {
        this.#cache = cache
        this.#runner = runner
        this.#gitEmailStore = gitEmailStore
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
                    resolveTokenForTag: (tag, opPath, signal, account) =>
                        resolveTokenForTag(tag, opPath, this.#cache, signal, account),
                    resolveAccountForEmail: (email, opPath, signal) =>
                        resolveAccountForEmail(email, opPath, this.#cache, signal),
                    resolveAccountForGitConfig: (subdir, opPath, signal) =>
                        resolveAccountForGitConfig(
                            subdir,
                            opPath,
                            this.#cache,
                            signal,
                            _folder?.uri.fsPath,
                            this.#gitEmailStore,
                        ),
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
    gitEmailStore: GitEmailStore,
): SecretDebugConfigurationProvider {
    return new SecretDebugConfigurationProvider(
        cache,
        new DefaultOpInjectRunner(),
        gitEmailStore,
    )
}

export function createGitEmailStore(ws: vscode.Memento): GitEmailStore {
    return new WorkspaceStateGitEmailStore(ws)
}
