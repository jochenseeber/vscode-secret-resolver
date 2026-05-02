import type * as vscode from "vscode"

import { EnvFileNotFoundError } from "./dotenv"
import {
    type EnvMap,
    findOpRefs,
    mergeEnv,
    parseSecretResolverMode,
    parseSignalOnStop,
    replaceOpRefs,
    type SignalStep,
    type StringEnvMap,
    stripInternalEnvVars,
} from "./envHelpers"
import { OpCliNotFoundError, OpInjectAbortedError, OpInjectError, type OpInjectRunner } from "./opInject"
import type { SecretCache } from "./secretCache"

const MODE_VAR = "SECRET_RESOLVER_MODE"
const SIGNAL_ON_STOP_VAR = "SECRET_RESOLVER_SIGNAL_ON_STOP"

/**
 * Custom field attached to the returned `DebugConfiguration` so the tracker
 * can read the parsed signal config via `session.configuration`. The field
 * name is intentionally non-DAP and is only set when the feature is in use.
 */
export const SECRET_RESOLVER_CONFIG_FIELD = "__secretResolver"

export interface SecretResolverSessionConfig {
    steps: SignalStep[]
}

const TERMINAL_CONSOLES = new Set([
    "integratedTerminal",
    "externalTerminal",
])

export interface ResolveDeps {
    cache: SecretCache
    runner: OpInjectRunner
    parseEnvFile: (path: string) => Promise<StringEnvMap>
    getOpPath: () => string
    showError: (message: string) => void
    showWarning: (message: string) => void
}

/**
 * Pure-logic resolver that takes a launch config and produces a new config
 * with `op://` refs resolved (or left intact for the legacy opt-in path).
 * Returns `undefined` to signal "abort the launch". Caller is expected to
 * have already shown any user-facing error via `deps.showError`.
 */
export async function resolveLaunchConfig(
    config: vscode.DebugConfiguration,
    deps: ResolveDeps,
    signal?: AbortSignal,
): Promise<vscode.DebugConfiguration | undefined> {
    const inlineEnv = config.env
    const envFilePath = typeof config.envFile === "string"
        ? config.envFile
        : undefined

    if (inlineEnv === undefined && envFilePath === undefined) {
        return config
    }

    if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
        return config
    }

    let fileMap: StringEnvMap = {}

    if (envFilePath !== undefined) {
        try {
            fileMap = await deps.parseEnvFile(envFilePath)
        }
        catch (err) {
            if (err instanceof EnvFileNotFoundError) {
                deps.showWarning(
                    `Secret Resolver: envFile not found: ${err.path}`,
                )
            }
            else {
                deps.showError(
                    `Secret Resolver: failed to read envFile: ${(err as Error).message}`,
                )
                return undefined
            }
        }
    }

    const merged = mergeEnv(fileMap, inlineEnv as EnvMap | undefined)
    const modeValue = merged[MODE_VAR]
    const consoleKind = typeof config.console === "string"
        ? config.console
        : ""
    const mode = parseSecretResolverMode(
        typeof modeValue === "string" ? modeValue : null,
        consoleKind,
    )

    if (mode === "op" && consoleKind === "internalConsole") {
        deps.showError(
            "Secret Resolver: SECRET_RESOLVER_MODE=\"op\" is incompatible with console=\"internalConsole\" (op run requires a terminal). Set SECRET_RESOLVER_MODE=\"cache\" in env, or change console to integratedTerminal or externalTerminal.",
        )
        return undefined
    }

    const stripped = stripInternalEnvVars(merged)
    const useOpRun = mode === "op" && TERMINAL_CONSOLES.has(consoleKind)

    let finalEnv: EnvMap

    if (useOpRun) {
        finalEnv = stripped
    }
    else {
        const resolved = await resolveAllRefs(stripped, deps, signal)

        if (resolved === undefined) {
            return undefined
        }

        finalEnv = replaceOpRefs(stripped, resolved)
    }

    const next: vscode.DebugConfiguration = { ...config, env: finalEnv }

    if ("envFile" in next) {
        delete next.envFile
    }

    const signalOnStop = parseSignalOnStop(
        typeof merged[SIGNAL_ON_STOP_VAR] === "string"
            ? (merged[SIGNAL_ON_STOP_VAR] as string)
            : null,
    )

    if (signalOnStop !== null && TERMINAL_CONSOLES.has(consoleKind)) {
        const sessionConfig: SecretResolverSessionConfig = { steps: signalOnStop }
        ;(next as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] = sessionConfig
    }

    return next
}

async function resolveAllRefs(
    env: EnvMap,
    deps: ResolveDeps,
    signal?: AbortSignal,
): Promise<Map<string, string> | undefined> {
    const refs = findOpRefs(env)

    if (refs.length === 0) {
        return new Map()
    }

    const out = new Map<string, string>()
    const missing: string[] = []

    for (const ref of refs) {
        const cached = deps.cache.get(ref)

        if (cached !== undefined) {
            out.set(ref, cached)
        }
        else {
            missing.push(ref)
        }
    }

    if (missing.length === 0) {
        return out
    }

    let resolved: Map<string, string>

    try {
        resolved = await deps.runner.resolve(
            missing,
            deps.getOpPath(),
            signal,
        )
    }
    catch (err) {
        if (err instanceof OpInjectAbortedError) {
            return undefined
        }

        if (err instanceof OpCliNotFoundError) {
            deps.showError(`Secret Resolver: ${err.message}`)
            return undefined
        }

        if (err instanceof OpInjectError) {
            deps.showError(`Secret Resolver: ${err.message}`)
            return undefined
        }

        deps.showError(
            `Secret Resolver: unexpected error invoking op inject: ${(err as Error).message}`,
        )
        return undefined
    }

    const unresolved = missing.filter((ref) => !resolved.has(ref))

    if (unresolved.length > 0) {
        deps.showError(
            `Secret Resolver: op inject did not return values for ${unresolved.length} reference(s); aborting launch.`,
        )
        return undefined
    }

    for (const [ref, value] of resolved) {
        deps.cache.set(ref, value)
        out.set(ref, value)
    }

    return out
}

function isStringEnvMap(value: unknown): value is EnvMap {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }

    for (const v of Object.values(value as Record<string, unknown>)) {
        if (v !== null && v !== undefined && typeof v !== "string") {
            return false
        }
    }

    return true
}
