import type * as vscode from "vscode"

import { EnvFileNotFoundError } from "./dotenv"
import {
    ACCOUNT_EMAIL_VAR,
    ACCOUNT_GIT_CONFIG_VAR,
    ACCOUNT_ID_VAR,
    type EnvMap,
    findOpRefs,
    hasOpRef,
    mergeEnv,
    MODE_VAR,
    parseSecretResolverMode,
    parseSignalOnStop,
    replaceOpRefs,
    SIGNAL_ON_STOP_VAR,
    type SignalStep,
    type StringEnvMap,
    stripInternalEnvVars,
    TOKEN_TAG_VAR,
} from "./envHelpers"
import { OpCliNotFoundError, OpInjectAbortedError, OpInjectError, type OpInjectRunner } from "./opInject"
import { getCachedResolvedRef, setCachedResolvedRef } from "./resolverCache"
import type { SecretCache } from "./secretCache"
import { buildSessionConfig, SECRET_RESOLVER_CONFIG_FIELD } from "./sessionConfig"

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
    resolveTokenForTag?: (tag: string, opPath: string, signal?: AbortSignal, account?: string) => Promise<string>
    resolveAccountForEmail?: (email: string, opPath: string, signal?: AbortSignal) => Promise<string>
    resolveAccountForGitConfig?: (subdir: string, opPath: string, signal?: AbortSignal) => Promise<string>
}

type LaunchEnvReadResult =
    | { kind: "unchanged" }
    | { kind: "resolved"; mergedEnv: EnvMap; strippedEnv: EnvMap }

interface AccountSelection {
    accountId: string | null
    email: string | null
    gitSubdir: string | null
}

interface LaunchOptions {
    mode: ReturnType<typeof parseSecretResolverMode>
    consoleKind: string
    isTerminalConsole: boolean
    useOpRun: boolean
    hasOpRefs: boolean
    tokenTag: string | null
    accountSelection: AccountSelection
    signalOnStop: SignalStep[] | null
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
    const launchEnv = await readLaunchEnv(config, deps)

    if (launchEnv === undefined) {
        return undefined
    }

    if (launchEnv.kind === "unchanged") {
        return config
    }

    const options = parseLaunchOptions(launchEnv.mergedEnv, launchEnv.strippedEnv, config, deps)

    if (options.mode === "op" && options.consoleKind === "internalConsole") {
        deps.showError(
            "Secret Resolver: SECRET_RESOLVER_MODE=\"op\" is incompatible with console=\"internalConsole\" (op run requires a terminal). Set SECRET_RESOLVER_MODE=\"cache\" in env, or change console to integratedTerminal or externalTerminal.",
        )
        return undefined
    }

    const accountId = await resolveLaunchAccount(options.accountSelection, deps, signal)

    if (accountId === undefined) {
        return undefined
    }

    const serviceAccountToken = await resolveLaunchToken(options, accountId, deps, signal)

    if (serviceAccountToken === null) {
        return undefined
    }

    const finalEnv = await resolveFinalEnv(
        launchEnv.strippedEnv,
        options,
        deps,
        signal,
        serviceAccountToken,
        accountId,
    )

    if (finalEnv === undefined) {
        return undefined
    }

    return buildResolvedDebugConfiguration(config, finalEnv, options, accountId)
}

async function readLaunchEnv(
    config: vscode.DebugConfiguration,
    deps: ResolveDeps,
): Promise<LaunchEnvReadResult | undefined> {
    const inlineEnv = config.env
    const envFilePath = typeof config.envFile === "string"
        ? config.envFile
        : undefined

    if (inlineEnv === undefined && envFilePath === undefined) {
        return { kind: "unchanged" }
    }

    if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
        return { kind: "unchanged" }
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

    const mergedEnv = mergeEnv(fileMap, inlineEnv as EnvMap | undefined)
    const strippedEnv = stripInternalEnvVars(mergedEnv)

    return { kind: "resolved", mergedEnv, strippedEnv }
}

function parseLaunchOptions(
    mergedEnv: EnvMap,
    strippedEnv: EnvMap,
    config: vscode.DebugConfiguration,
    deps: ResolveDeps,
): LaunchOptions {
    const consoleKind = typeof config.console === "string"
        ? config.console
        : ""
    const modeValue = mergedEnv[MODE_VAR]
    const mode = parseSecretResolverMode(
        typeof modeValue === "string" ? modeValue : null,
        deps.showWarning,
    )
    const isTerminalConsole = TERMINAL_CONSOLES.has(consoleKind)
    const useOpRun = mode === "op" && isTerminalConsole
    const tokenTag = getTrimmedEnvValue(mergedEnv, TOKEN_TAG_VAR)
    const signalOnStop = parseSignalOnStop(
        getTrimmedEnvValue(mergedEnv, SIGNAL_ON_STOP_VAR),
        deps.showWarning,
    )

    return {
        mode,
        consoleKind,
        isTerminalConsole,
        useOpRun,
        hasOpRefs: hasOpRef(strippedEnv),
        tokenTag,
        accountSelection: {
            accountId: getTrimmedEnvValue(mergedEnv, ACCOUNT_ID_VAR),
            email: getTrimmedEnvValue(mergedEnv, ACCOUNT_EMAIL_VAR),
            gitSubdir: getTrimmedEnvValue(mergedEnv, ACCOUNT_GIT_CONFIG_VAR),
        },
        signalOnStop,
    }
}

async function resolveLaunchAccount(
    selection: AccountSelection,
    deps: ResolveDeps,
    signal?: AbortSignal,
): Promise<string | null | undefined> {
    if (selection.accountId !== null) {
        return selection.accountId
    }

    if (selection.email !== null && deps.resolveAccountForEmail !== undefined) {
        try {
            return await deps.resolveAccountForEmail(selection.email, deps.getOpPath(), signal)
        }
        catch (err) {
            deps.showError(`Secret Resolver: ${(err as Error).message}`)
            return undefined
        }
    }

    if (selection.gitSubdir !== null && deps.resolveAccountForGitConfig !== undefined) {
        try {
            return await deps.resolveAccountForGitConfig(selection.gitSubdir, deps.getOpPath(), signal)
        }
        catch (err) {
            deps.showError(`Secret Resolver: ${(err as Error).message}`)
            return undefined
        }
    }

    return null
}

async function resolveLaunchToken(
    options: LaunchOptions,
    accountId: string | null,
    deps: ResolveDeps,
    signal?: AbortSignal,
): Promise<string | undefined | null> {
    if (options.tokenTag === null || !options.hasOpRefs || deps.resolveTokenForTag === undefined) {
        return undefined
    }

    try {
        return await deps.resolveTokenForTag(
            options.tokenTag,
            deps.getOpPath(),
            signal,
            accountId ?? undefined,
        )
    }
    catch (err) {
        deps.showError(`Secret Resolver: ${(err as Error).message}`)
        return null
    }
}

async function resolveFinalEnv(
    strippedEnv: EnvMap,
    options: LaunchOptions,
    deps: ResolveDeps,
    signal: AbortSignal | undefined,
    serviceAccountToken: string | undefined,
    accountId: string | null,
): Promise<EnvMap | undefined> {
    if (options.useOpRun) {
        return strippedEnv
    }

    const resolved = await resolveAllRefs(
        strippedEnv,
        deps,
        signal,
        serviceAccountToken,
        accountId ?? undefined,
    )

    if (resolved === undefined) {
        return undefined
    }

    return replaceOpRefs(strippedEnv, resolved)
}

function buildResolvedDebugConfiguration(
    config: vscode.DebugConfiguration,
    finalEnv: EnvMap,
    options: LaunchOptions,
    accountId: string | null,
): vscode.DebugConfiguration {
    const next: vscode.DebugConfiguration = { ...config, env: finalEnv }

    if ("envFile" in next) {
        delete next.envFile
    }

    if (options.isTerminalConsole) {
        const sessionConfig = buildSessionConfig({
            signalOnStop: options.signalOnStop,
            tokenTag: options.hasOpRefs ? options.tokenTag : null,
            useOpRun: options.useOpRun,
            accountId,
        })

        if (sessionConfig === undefined) {
            return next
        }

        ;(next as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] = sessionConfig
    }

    return next
}

function getTrimmedEnvValue(env: EnvMap, key: string): string | null {
    const value = env[key]

    if (typeof value !== "string") {
        return null
    }

    const trimmed = value.trim()

    return trimmed === "" ? null : trimmed
}

async function resolveAllRefs(
    env: EnvMap,
    deps: ResolveDeps,
    signal?: AbortSignal,
    token?: string,
    account?: string,
): Promise<Map<string, string> | undefined> {
    const refs = findOpRefs(env)

    if (refs.length === 0) {
        return new Map()
    }

    const out = new Map<string, string>()
    const missing: string[] = []

    for (const ref of refs) {
        const cached = getCachedResolvedRef(deps.cache, ref)

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
            token,
            account,
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
        setCachedResolvedRef(deps.cache, ref, value)
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
