import * as vscode from "vscode"

import type { GitEmailStore } from "./accountResolver"
import { createDefaultProvider, createGitEmailStore } from "./configProvider"
import { SecretDebugAdapterTrackerFactory } from "./debugAdapterProxy"
import { SecretCache } from "./secretCache"
import { cleanupRegistry, InMemoryTempDirRegistry, sweepStaleTempDirs } from "./tempDirRegistry"

const CLEAR_CACHE_COMMAND = "secretResolver.clearCache"
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const

let activeCache: SecretCache | undefined
let activeRegistry: InMemoryTempDirRegistry | undefined
let activeGitEmailStore: GitEmailStore | undefined
let signalHandlersInstalled = false

export function activate(context: vscode.ExtensionContext): void {
    const cache = new SecretCache()
    const registry = new InMemoryTempDirRegistry()
    const gitEmailStore = createGitEmailStore(context.workspaceState)
    gitEmailStore.clear()
    activeCache = cache
    activeRegistry = registry
    activeGitEmailStore = gitEmailStore

    sweepStaleTempDirs()
    installProcessHandlers()

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            "*",
            createDefaultProvider(cache, gitEmailStore),
        ),
        vscode.debug.registerDebugAdapterTrackerFactory(
            "*",
            new SecretDebugAdapterTrackerFactory(
                registry,
                (pid, sig) => {
                    process.kill(pid, sig)
                },
                setTimeout,
                clearTimeout,
                undefined,
                (tag) => cache.get(`__token__:${tag}`),
            ),
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
    activeCache?.clear()
    activeCache = undefined

    activeGitEmailStore?.clear()
    activeGitEmailStore = undefined

    if (activeRegistry !== undefined) {
        cleanupRegistry(activeRegistry)
        activeRegistry = undefined
    }
}

function installProcessHandlers(): void {
    if (signalHandlersInstalled) {
        return
    }

    signalHandlersInstalled = true

    process.on("exit", () => {
        if (activeRegistry !== undefined) {
            cleanupRegistry(activeRegistry)
        }
    })

    for (const signal of TERMINATION_SIGNALS) {
        process.on(signal, () => {
            if (activeRegistry !== undefined) {
                cleanupRegistry(activeRegistry)
            }
        })
    }
}
