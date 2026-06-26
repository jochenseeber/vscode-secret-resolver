export type SignalName = "TERM" | "KILL" | "INT" | "HUP"

export interface SignalStep {
    delaySec: number
    signal: SignalName
}

/**
 * Every valid `SignalName`, for validating externally supplied values.
 */
export const SIGNAL_NAMES: ReadonlySet<SignalName> = new Set(["TERM", "KILL", "INT", "HUP"])

/**
 * Custom field attached to the returned `DebugConfiguration` so the tracker
 * can read resolver metadata via `session.configuration`. The field name is
 * intentionally non-DAP and is only set when a terminal launch needs it.
 */
export const SECRET_RESOLVER_CONFIG_FIELD = "__secretResolver"

export interface SecretResolverSessionConfig {
    steps: SignalStep[]
    accountId?: string
}

export interface BuildSessionConfigOptions {
    signalOnStop: SignalStep[] | null
    accountId: string | null
}

/**
 * Builds and parses the `__secretResolver` session metadata. The producer
 * (`LaunchConfigResolver`) and the consumer (the debug adapter tracker) share
 * this codec so the runtime validation lives in exactly one place.
 */
export class SessionConfigCodec {
    static build(
        options: BuildSessionConfigOptions,
    ): SecretResolverSessionConfig | undefined {
        const steps = options.signalOnStop ?? []
        const accountId = options.accountId ?? undefined

        if (steps.length === 0 && accountId === undefined) {
            return undefined
        }

        const sessionConfig: SecretResolverSessionConfig = {
            steps,
            ...(accountId !== undefined ? { accountId } : {}),
        }
        return sessionConfig
    }

    static parse(
        configuration: unknown,
    ): SecretResolverSessionConfig | undefined {
        if (typeof configuration !== "object" || configuration === null) {
            return undefined
        }

        const raw = (configuration as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD]

        if (typeof raw !== "object" || raw === null) {
            return undefined
        }

        const candidate = raw as { steps?: unknown; accountId?: unknown }
        const hasSteps = Array.isArray(candidate.steps)
            && candidate.steps.length > 0
            && candidate.steps.every(SessionConfigCodec.isSignalStep)
        const accountId = typeof candidate.accountId === "string" && candidate.accountId !== ""
            ? candidate.accountId
            : undefined

        if (!hasSteps && accountId === undefined) {
            return undefined
        }

        const steps = hasSteps ? (candidate.steps as SignalStep[]) : []

        const sessionConfig: SecretResolverSessionConfig = {
            steps,
            ...(accountId !== undefined ? { accountId } : {}),
        }
        return sessionConfig
    }

    private static isSignalStep(value: unknown): value is SignalStep {
        if (typeof value !== "object" || value === null) {
            return false
        }

        const step = value as Partial<SignalStep>
        const isValid = typeof step.delaySec === "number"
            && step.delaySec >= 0
            && typeof step.signal === "string"
            && SIGNAL_NAMES.has(step.signal as SignalName)
        return isValid
    }
}
