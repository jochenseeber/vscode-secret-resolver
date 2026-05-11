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
        const emails = this.ws.get<Record<string, string>>(GIT_EMAILS_KEY)
        const email = emails?.[dir]
        return email
    }

    set(dir: string, email: string): void {
        const current = this.ws.get<Record<string, string>>(GIT_EMAILS_KEY) ?? {}
        this.updateBestEffort({ ...current, [dir]: email })
    }

    clear(): void {
        this.updateBestEffort(undefined)
    }

    private updateBestEffort(value: Record<string, string> | undefined): void {
        void this.ws.update(GIT_EMAILS_KEY, value).then(undefined, (err: unknown) => {
            console.warn(
                `[secret-resolver] failed to persist git email cache: ${(err as Error).message}`,
            )
        })
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
            const resolved = await resolveLaunchConfig(
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
            return resolved
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
