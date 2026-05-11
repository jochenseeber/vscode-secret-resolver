import * as vscode from "vscode"

import { createDefaultProvider, createGitEmailStore } from "./configProvider"
import { cleanupRegistry, InMemoryTempDirRegistry, sweepStaleTempDirs } from "./tempDirRegistry"

import type { GitEmailStore } from "./accountResolver"
import { SecretDebugAdapterTrackerFactory } from "./debugAdapterProxy"
import { getCachedToken } from "./tokenResolver"
import { SecretCache } from "./secretCache"

const CLEAR_CACHE_COMMAND = "secretResolver.clearCache"
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const

interface ExtensionState {
    cache: SecretCache
    registry: InMemoryTempDirRegistry
    gitEmailStore: GitEmailStore
}

let state: ExtensionState | undefined
let signalHandlersInstalled = false

export function activate(context: vscode.ExtensionContext): void {
    const cache = new SecretCache()
    const registry = new InMemoryTempDirRegistry()
    const gitEmailStore = createGitEmailStore(context.workspaceState)
    gitEmailStore.clear()
    state = { cache, registry, gitEmailStore }

    sweepStaleTempDirs()
    installProcessHandlers()

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            "*",
            createDefaultProvider(cache, gitEmailStore),
        ),
        vscode.debug.registerDebugAdapterTrackerFactory(
            "*",
            new SecretDebugAdapterTrackerFactory(registry, {
                getServiceAccountToken: (tag) => getCachedToken(cache, tag),
            }),
        ),
        vscode.commands.registerCommand(CLEAR_CACHE_COMMAND, () => {
            cache.clear()
            gitEmailStore.clear()
            void vscode.window.showInformationMessage(
                "Secret Resolver: cache cleared.",
            )
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("secretResolver.opPath")) {
                cache.clear()
                gitEmailStore.clear()
            }
        }),
    )
}

export function deactivate(): void {
    if (state !== undefined) {
        state.cache.clear()
        state.gitEmailStore.clear()
        cleanupRegistry(state.registry)
        state = undefined
    }
}

function installProcessHandlers(): void {
    if (signalHandlersInstalled) {
        return
    }

    signalHandlersInstalled = true

    process.on("exit", () => {
        if (state !== undefined) {
            cleanupRegistry(state.registry)
        }
    })

    for (const signal of TERMINATION_SIGNALS) {
        process.on(signal, () => {
            if (state !== undefined) {
                cleanupRegistry(state.registry)
            }
        })
    }
}
