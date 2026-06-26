import * as vscode from "vscode"

import { SecretDebugConfigurationProvider } from "./configProvider"
import { SecretDebugAdapterTrackerFactory } from "./debugAdapterProxy"
import { SecretCache } from "./secretCache"
import { InMemoryTempDirRegistry } from "./tempDirRegistry"
import { OutputChannelLogger } from "./vscodeAdapters"

const CLEAR_CACHE_COMMAND = "secretResolver.clearCache"
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const

/**
 * Owns the extension's session-scoped state — the secret cache and the temp-dir
 * registry — and wires it into VS Code on activation. VS Code's required
 * top-level `activate`/`deactivate` hooks and the process-termination handlers
 * delegate to the single instance held in `extension` below.
 */
class Extension {
    private readonly cache = new SecretCache()
    private readonly registry = new InMemoryTempDirRegistry()

    activate(context: vscode.ExtensionContext): void {
        InMemoryTempDirRegistry.sweepStale()

        const outputChannel = vscode.window.createOutputChannel("Secret Resolver", { log: true })
        const logger = new OutputChannelLogger(outputChannel)
        const provider = new SecretDebugConfigurationProvider(this.cache, logger)

        context.subscriptions.push(
            outputChannel,
            vscode.debug.registerDebugConfigurationProvider("*", provider),
            vscode.debug.registerDebugAdapterTrackerFactory(
                "*",
                new SecretDebugAdapterTrackerFactory(this.registry, { logger }),
            ),
            vscode.commands.registerCommand(CLEAR_CACHE_COMMAND, () => {
                this.cache.clear()
                void vscode.window.showInformationMessage(
                    "Secret Resolver: cache cleared.",
                )
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("secretResolver.opPath")) {
                    this.cache.clear()
                    provider.refreshResolver()
                }
            }),
        )
    }

    /**
     * Synchronous best-effort temp-dir cleanup, safe to call from
     * `process.on('exit'|signals)`. Leaves the cache alone.
     */
    cleanupTempDirs(): void {
        this.registry.cleanup()
    }

    dispose(): void {
        this.cache.clear()
        this.registry.cleanup()
    }
}

// Single module-level handle bridging VS Code's top-level `activate` /
// `deactivate` hooks and the process-termination handlers to the live state.
// A module-level reference is unavoidable: `deactivate()` takes no arguments
// and the signal handlers fire outside VS Code's `context.subscriptions`
// disposal.
let extension: Extension | undefined

// Installed once per extension-host process (module bodies run once), so no
// re-install guard is needed; they no-op until `activate` sets `extension`.
process.on("exit", () => extension?.cleanupTempDirs())

for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => extension?.cleanupTempDirs())
}

export function activate(context: vscode.ExtensionContext): void {
    extension = new Extension()
    extension.activate(context)
}

export function deactivate(): void {
    extension?.dispose()
    extension = undefined
}
