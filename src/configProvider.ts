import * as vscode from "vscode"

import { type GitEmailStore, resolveAccountForEmail, resolveAccountForGitConfig } from "./accountResolver"
import { parseEnvFile } from "./dotenv"
import { GitRunner } from "./gitRunner"
import { OpRunner } from "./opRunner"
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
    readonly #gitEmailStore: GitEmailStore

    constructor(cache: SecretCache, gitEmailStore: GitEmailStore) {
        this.#cache = cache
        this.#gitEmailStore = gitEmailStore
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const opPath = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath", "op")
        const opRunner = new OpRunner(opPath)
        const gitRunner = new GitRunner()

        const controller = new AbortController()
        const subscription = token?.onCancellationRequested(() => {
            controller.abort()
        })

        try {
            const resolved = await resolveLaunchConfig(
                debugConfiguration,
                {
                    cache: this.#cache,
                    runner: opRunner,
                    parseEnvFile,
                    showError: (m) => {
                        void vscode.window.showErrorMessage(m)
                    },
                    showWarning: (m) => {
                        void vscode.window.showWarningMessage(m)
                    },
                    resolveTokenForTag: (tag, signal, account) =>
                        resolveTokenForTag(tag, opRunner, this.#cache, signal, account),
                    resolveAccountForEmail: (email, signal) =>
                        resolveAccountForEmail(email, opRunner, this.#cache, signal),
                    resolveAccountForGitConfig: (subdir, signal) =>
                        resolveAccountForGitConfig(
                            subdir,
                            opRunner,
                            gitRunner,
                            this.#cache,
                            signal,
                            folder?.uri.fsPath,
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
    return new SecretDebugConfigurationProvider(cache, gitEmailStore)
}

export function createGitEmailStore(ws: vscode.Memento): GitEmailStore {
    return new WorkspaceStateGitEmailStore(ws)
}
