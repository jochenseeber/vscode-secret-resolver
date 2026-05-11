import type { SignalName, SignalStep } from "./envHelpers"

/**
 * Custom field attached to the returned `DebugConfiguration` so the tracker
 * can read resolver metadata via `session.configuration`. The field name is
 * intentionally non-DAP and is only set when a terminal launch needs it.
 */
export const SECRET_RESOLVER_CONFIG_FIELD = "__secretResolver"

export interface SecretResolverSessionConfig {
    steps: SignalStep[]
    tokenTag?: string
    accountId?: string
}

export interface BuildSessionConfigOptions {
    signalOnStop: SignalStep[] | null
    tokenTag: string | null
    useOpRun: boolean
    accountId: string | null
}

export function buildSessionConfig(
    options: BuildSessionConfigOptions,
): SecretResolverSessionConfig | undefined {
    const steps = options.signalOnStop ?? []
    const tokenTag = options.tokenTag !== null && options.useOpRun
        ? options.tokenTag
        : undefined
    const accountId = options.accountId ?? undefined

    if (steps.length === 0 && tokenTag === undefined && accountId === undefined) {
        return undefined
    }

    return {
        steps,
        ...(tokenTag !== undefined ? { tokenTag } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
    }
}

export function parseSessionConfig(
    configuration: unknown,
): SecretResolverSessionConfig | undefined {
    if (typeof configuration !== "object" || configuration === null) {
        return undefined
    }

    const raw = (configuration as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD]

    if (typeof raw !== "object" || raw === null) {
        return undefined
    }

    const candidate = raw as { steps?: unknown; tokenTag?: unknown; accountId?: unknown }
    const hasSteps = Array.isArray(candidate.steps)
        && candidate.steps.length > 0
        && candidate.steps.every(isSignalStep)
    const tokenTag = typeof candidate.tokenTag === "string" && candidate.tokenTag !== ""
        ? candidate.tokenTag
        : undefined
    const accountId = typeof candidate.accountId === "string" && candidate.accountId !== ""
        ? candidate.accountId
        : undefined

    if (!hasSteps && tokenTag === undefined && accountId === undefined) {
        return undefined
    }

    const steps = hasSteps ? (candidate.steps as SignalStep[]) : []

    return {
        steps,
        ...(tokenTag !== undefined ? { tokenTag } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
    }
}

const SIGNAL_NAMES: ReadonlySet<SignalName> = new Set(["TERM", "KILL", "INT", "HUP"])

function isSignalStep(value: unknown): value is SignalStep {
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
