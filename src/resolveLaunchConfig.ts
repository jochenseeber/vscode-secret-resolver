import type * as vscode from "vscode"

import {
    AccountResolver,
    type AccountResolverFactory,
    LiteralAccountResolver,
    NullAccountResolver,
} from "./accountResolver"
import { EnvFileNotFoundError } from "./dotenv"
import { OpInjectAbortedError, OpRunner } from "./opRunner"
import type { RefResolutionScope, ResolverCache } from "./resolverCache"
import {
    SECRET_RESOLVER_CONFIG_FIELD,
    SessionConfigCodec,
    SIGNAL_NAMES,
    type SignalName,
    type SignalStep,
} from "./sessionConfig"
import { StringEnvMap } from "./stringEnvMap"
import type { TokenResolverFactory } from "./tokenResolver"
import type { UserNotifier } from "./userNotifier"

const SIGNAL_ON_STOP_VAR = "SECRET_RESOLVER_SIGNAL_ON_STOP"

const TOKEN_TAG_VAR = "SECRET_RESOLVER_TOKEN_TAG"

const ACCOUNT_EMAIL_VAR = "SECRET_RESOLVER_ACCOUNT_EMAIL"

const ACCOUNT_GIT_CONFIG_VAR = "SECRET_RESOLVER_ACCOUNT_GIT_CONFIG"

const ACCOUNT_ID_VAR = "SECRET_RESOLVER_ACCOUNT_ID"

const SANITIZE_VARS_VAR = "SECRET_RESOLVER_SANITIZE_VARS"

/**
 * Reads and parses a launch `envFile`. Implemented via `DotenvFile` in
 * production (see `configProvider.ts`); tests inject in-memory fakes.
 */
export interface EnvFileReader {
    parse(path: string): Promise<Record<string, string>>
}

/**
 * Reports whether the current workspace is trusted. Implemented via
 * `vscode.workspace.isTrusted` in production (see `configProvider.ts`); tests
 * inject fakes. Secrets are never resolved for untrusted workspaces, matching
 * the `untrustedWorkspaces: "limited"` declaration in `package.json`.
 */
export interface WorkspaceTrustReader {
    isTrusted(): boolean
}

/**
 * VS Code-settings defaults for the account/token launch markers. Each field
 * mirrors one `SECRET_RESOLVER_*` marker; a matching env var in the launch
 * always overrides the setting. Absent settings are `undefined`.
 */
export interface ResolverSettings {
    accountId?: string
    accountGitConfig?: string
    accountEmail?: string
    tokenTag?: string
    signalOnStop?: string
    sanitizeVars?: string
}

/**
 * Reads the resolver's marker-default settings. Implemented via
 * `vscode.workspace.getConfiguration` in production (see `vscodeAdapters.ts`);
 * tests inject fakes. Read fresh on every launch so setting edits take effect
 * without rebuilding the resolver. `workspacePath` scopes the lookup to the
 * launch's folder so per-folder (project) settings apply on top of workspace
 * and user settings; it is `undefined` for launches with no folder.
 */
export interface ResolverSettingsReader {
    read(workspacePath: string | undefined): ResolverSettings
}

/**
 * Result of parsing `SECRET_RESOLVER_SIGNAL_ON_STOP`: explicitly or
 * implicitly off, unparsable (warn and treat as off), or a step sequence.
 */
type SignalOnStopParseResult =
    | { kind: "off" }
    | { kind: "invalid" }
    | { kind: "steps"; steps: SignalStep[] }

export class LaunchConfigResolver {
    private static readonly OP_REF_PATTERN = /^op:\/\//
    private static readonly DEFAULT_STEP_DELAY_SECONDS = 30
    private static readonly STEP_PATTERN = /^(?:([0-9]+):)?([a-zA-Z]+)$/
    // Keep in sync with the `secretResolver.sanitizeVars` default in `package.json`.
    private static readonly DEFAULT_SANITIZE_PATTERN = "^(OP_|SECRET_RESOLVER_)"

    constructor(
        private readonly cache: ResolverCache,
        private readonly runner: OpRunner,
        private readonly envFileReader: EnvFileReader,
        private readonly notifier: UserNotifier,
        private readonly accountResolverFactory: AccountResolverFactory,
        private readonly tokenResolverFactory: TokenResolverFactory,
        private readonly workspaceTrust: WorkspaceTrustReader,
        private readonly settingsReader: ResolverSettingsReader,
    ) {}

    async resolve(
        config: vscode.DebugConfiguration,
        workspacePath: string | undefined,
        signal?: AbortSignal,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const sanitizedConfig = LaunchConfigResolver.removeSessionConfigField(config)
        const launchEnv = sanitizedConfig.env
        const envFilePath = typeof sanitizedConfig.envFile === "string"
            ? sanitizedConfig.envFile
            : undefined

        if (launchEnv === undefined && envFilePath === undefined) {
            return sanitizedConfig
        }

        if (!this.workspaceTrust.isTrusted()) {
            this.notifier.showError(
                "Secret Resolver: workspace is not trusted; refusing to resolve the launch environment.",
            )
            return undefined
        }

        try {
            const env = new StringEnvMap()

            if (envFilePath !== undefined) {
                env.addAll(await this.readEnvFile(envFilePath))
            }

            if (launchEnv !== undefined) {
                env.addAll(new StringEnvMap(launchEnv))
            }

            const settings = this.settingsReader.read(workspacePath)

            const signalParse = LaunchConfigResolver.parseSignalOnStop(
                LaunchConfigResolver.effectiveMarkerValue(
                    env,
                    SIGNAL_ON_STOP_VAR,
                    settings.signalOnStop,
                ),
            )

            if (signalParse.kind === "invalid") {
                this.notifier.showWarning(
                    `invalid SECRET_RESOLVER_SIGNAL_ON_STOP value; defaulting to off`,
                )
            }

            const signalOnStop = signalParse.kind === "steps" ? signalParse.steps : null

            const tokenTag = LaunchConfigResolver.effectiveMarkerValue(
                env,
                TOKEN_TAG_VAR,
                settings.tokenTag,
            ) || null
            const accountId = await this.resolveLaunchAccount(env, settings, workspacePath, signal)
            const serviceAccountToken = await this.resolveServiceAccountToken(
                env,
                tokenTag,
                accountId,
                signal,
            )

            const sanitizeMatcher = this.buildSanitizeMatcher(
                LaunchConfigResolver.effectiveMarkerValue(env, SANITIZE_VARS_VAR, settings.sanitizeVars),
            )

            env.deleteIf((key) => sanitizeMatcher !== null && sanitizeMatcher.test(key))

            const resolutionScope: RefResolutionScope = { accountId, tokenTag }
            const finalEnv = await this.resolveFinalEnv(
                env,
                serviceAccountToken,
                resolutionScope,
                signal,
            )

            const resolvedConfig = this.buildResolvedDebugConfiguration(
                sanitizedConfig,
                finalEnv,
                signalOnStop,
                accountId,
            )
            return resolvedConfig
        }
        catch (err) {
            if (err instanceof OpInjectAbortedError) {
                return undefined
            }

            this.notifier.showError((err as Error).message)
            return undefined
        }
    }

    private async readEnvFile(path: string): Promise<StringEnvMap> {
        try {
            const fileEnv = new StringEnvMap(await this.envFileReader.parse(path))
            return fileEnv
        }
        catch (err) {
            if (err instanceof EnvFileNotFoundError) {
                this.notifier.showWarning(`Secret Resolver: envFile not found: ${err.path}`)
                const emptyEnv = new StringEnvMap()
                return emptyEnv
            }

            throw new Error(`failed to read envFile: ${(err as Error).message}`)
        }
    }

    private async resolveLaunchAccount(
        env: StringEnvMap,
        settings: ResolverSettings,
        workspacePath: string | undefined,
        signal?: AbortSignal,
    ): Promise<string | null> {
        const gitSubdirectory = LaunchConfigResolver.effectiveMarkerValue(
            env,
            ACCOUNT_GIT_CONFIG_VAR,
            settings.accountGitConfig,
        )
        const email = LaunchConfigResolver.effectiveMarkerValue(
            env,
            ACCOUNT_EMAIL_VAR,
            settings.accountEmail,
        )
        const accountId = LaunchConfigResolver.effectiveMarkerValue(
            env,
            ACCOUNT_ID_VAR,
            settings.accountId,
        )

        let resolver: AccountResolver

        if (gitSubdirectory) {
            resolver = this.accountResolverFactory.createForGitConfig(gitSubdirectory, workspacePath)
        }
        else if (email) {
            resolver = this.accountResolverFactory.createForEmail(email)
        }
        else if (accountId) {
            resolver = new LiteralAccountResolver(accountId)
        }
        else {
            resolver = new NullAccountResolver()
        }

        const resolvedAccountId = await resolver.resolve(signal)
        return resolvedAccountId
    }

    private async resolveServiceAccountToken(
        env: StringEnvMap,
        tag: string | null,
        accountId: string | null,
        signal?: AbortSignal,
    ): Promise<string | null> {
        if (tag === null || !env.some((_key, value) => LaunchConfigResolver.isOpRef(value))) {
            return null
        }

        const resolver = this.tokenResolverFactory.createForTag(tag)
        const token = await resolver.resolve(accountId ?? undefined, signal)
        const resolvedToken = token ?? null
        return resolvedToken
    }

    private async resolveFinalEnv(
        strippedEnv: StringEnvMap,
        serviceAccountToken: string | null,
        scope: RefResolutionScope,
        signal?: AbortSignal,
    ): Promise<Record<string, string>> {
        const resolved = await this.resolveAllRefs(
            strippedEnv,
            serviceAccountToken,
            scope,
            signal,
        )

        const patch = new StringEnvMap()

        strippedEnv.forEach((key, value) => {
            const resolvedValue = resolved.get(value)

            if (resolvedValue !== undefined) {
                patch.setValue(key, resolvedValue)
            }
        })

        const result = new StringEnvMap()
        result.addAll(strippedEnv)
        result.addAll(patch)
        const finalEnv = result.toRecord()
        return finalEnv
    }

    private buildResolvedDebugConfiguration(
        config: vscode.DebugConfiguration,
        finalEnv: Record<string, string>,
        signalOnStop: SignalStep[] | null,
        accountId: string | null,
    ): vscode.DebugConfiguration {
        const next: vscode.DebugConfiguration = { ...config, env: finalEnv }

        if ("envFile" in next) {
            delete next.envFile
        }

        const sessionConfig = SessionConfigCodec.build({
            signalOnStop,
            accountId,
        })

        if (sessionConfig !== undefined) {
            ;(next as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] = sessionConfig
        }

        return next
    }

    /**
     * Returns `config` without any pre-existing session-config field. The
     * field is an internal resolver → tracker channel; an incoming value was
     * authored by the launch config, not by this extension, and is discarded.
     * Returns the input unchanged when the field is absent.
     */
    private static removeSessionConfigField(
        config: vscode.DebugConfiguration,
    ): vscode.DebugConfiguration {
        if (!(SECRET_RESOLVER_CONFIG_FIELD in config)) {
            return config
        }

        const sanitized = { ...config }
        delete (sanitized as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD]
        return sanitized
    }

    private async resolveAllRefs(
        env: StringEnvMap,
        token: string | null,
        scope: RefResolutionScope,
        signal?: AbortSignal,
    ): Promise<Map<string, string>> {
        const opRefEnv = env.filter((_key, value) => LaunchConfigResolver.isOpRef(value))
        const refs = [...new Set(opRefEnv.valueList())]

        if (refs.length === 0) {
            const empty = new Map<string, string>()
            return empty
        }

        const out = new Map<string, string>()
        const missing: string[] = []

        for (const ref of refs) {
            const cached = this.cache.getResolvedRef(ref, scope)

            if (cached !== null) {
                out.set(ref, cached)
            }
            else {
                missing.push(ref)
            }
        }

        if (missing.length === 0) {
            return out
        }

        const resolved = await this.runner.inject(
            missing,
            { signal, token: token ?? undefined, account: scope.accountId ?? undefined },
        )

        const unresolved = missing.filter((ref) => !resolved.has(ref))

        if (unresolved.length > 0) {
            throw new Error(
                `op inject did not return values for ${unresolved.length} reference(s); aborting launch.`,
            )
        }

        for (const [ref, value] of resolved) {
            this.cache.setResolvedRef(ref, scope, value)
            out.set(ref, value)
        }

        return out
    }

    /**
     * Effective value for a launch marker. The env var wins when present — even
     * when empty, so an explicit empty var switches the marker off — otherwise
     * the VS Code setting default applies. Both are trimmed; an empty result
     * reads as "unset" by the callers.
     */
    private static effectiveMarkerValue(
        env: StringEnvMap,
        key: string,
        settingValue: string | undefined,
    ): string | undefined {
        if (env.hasKey(key)) {
            const envValue = env.getTrimmedValue(key)
            return envValue
        }

        const trimmedSetting = settingValue?.trim()
        return trimmedSetting
    }

    /**
     * Compiles the effective `SECRET_RESOLVER_SANITIZE_VARS` value into the
     * matcher over env-variable names to strip from the launch environment. It
     * is the only stripping mechanism: an unset value (no env var and no
     * setting) applies `DEFAULT_SANITIZE_PATTERN` (which removes `OP_*` and
     * `SECRET_RESOLVER_*`); an explicitly empty value disables stripping
     * entirely; an unparsable pattern warns and falls back to the default.
     */
    private buildSanitizeMatcher(source: string | undefined): RegExp | null {
        if (source === undefined) {
            const defaultMatcher = new RegExp(LaunchConfigResolver.DEFAULT_SANITIZE_PATTERN)
            return defaultMatcher
        }

        if (source === "") {
            return null
        }

        try {
            const matcher = new RegExp(source)
            return matcher
        }
        catch {
            this.notifier.showWarning(
                `invalid SECRET_RESOLVER_SANITIZE_VARS regexp; falling back to the default (${LaunchConfigResolver.DEFAULT_SANITIZE_PATTERN})`,
            )
            const fallback = new RegExp(LaunchConfigResolver.DEFAULT_SANITIZE_PATTERN)
            return fallback
        }
    }

    /**
     * True when `value` is a non-null string that begins with `op://`.
     */
    private static isOpRef(value: string | null | undefined): value is string {
        const isRef = typeof value === "string" && LaunchConfigResolver.OP_REF_PATTERN.test(value)
        return isRef
    }

    /**
     * Parses `SECRET_RESOLVER_SIGNAL_ON_STOP` into an ordered list of signal
     * steps. Format: `(([0-9]+:)?SIGNAL)(+(([0-9]+:)?SIGNAL))*` where SIGNAL is
     * one of TERM, KILL, INT, HUP (case-insensitive). An optional `N:` prefix on
     * each step sets the delay in seconds before that signal is sent; the default
     * is 0 for the first step and `DEFAULT_STEP_DELAY_SECONDS` for all others.
     * Missing / empty / `"off"` values yield `kind: "off"`; any parse error
     * yields `kind: "invalid"` so the caller can warn.
     */
    private static parseSignalOnStop(value: string | null | undefined): SignalOnStopParseResult {
        if (typeof value !== "string") {
            const off: SignalOnStopParseResult = { kind: "off" }
            return off
        }

        const trimmed = value.trim()

        if (trimmed === "" || trimmed.toLowerCase() === "off") {
            const off: SignalOnStopParseResult = { kind: "off" }
            return off
        }

        const tokens = trimmed.split("+")
        const steps: SignalStep[] = []

        for (let i = 0; i < tokens.length; i += 1) {
            const token = tokens[i].trim()
            const match = LaunchConfigResolver.STEP_PATTERN.exec(token)

            if (match === null) {
                const invalid: SignalOnStopParseResult = { kind: "invalid" }
                return invalid
            }

            const delayStr = match[1]
            const signalStr = match[2].toUpperCase() as SignalName

            if (!SIGNAL_NAMES.has(signalStr)) {
                const invalid: SignalOnStopParseResult = { kind: "invalid" }
                return invalid
            }

            const delaySec = delayStr !== undefined
                ? Number(delayStr)
                : i === 0
                ? 0
                : LaunchConfigResolver.DEFAULT_STEP_DELAY_SECONDS

            steps.push({ delaySec, signal: signalStr })
        }

        const result: SignalOnStopParseResult = { kind: "steps", steps }
        return result
    }
}
