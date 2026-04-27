/**
 * Pure helpers for inspecting and rewriting debug-launch env maps. No
 * `vscode` import; safe to use from unit tests and from the config provider.
 */

export const OP_REF_PATTERN = /^op:\/\//;

const INTERNAL_VAR_PATTERN = /^SECRET_RESOLVER_/;

export type SecretResolverMode = "op" | "cache";

export type EnvMap = Record<string, string | null | undefined>;

export type StringEnvMap = Record<string, string>;

/**
 * True when `value` is a non-null string that begins with `op://`.
 */
export function isOpRef(value: string | null | undefined): value is string {
    return typeof value === "string" && OP_REF_PATTERN.test(value);
}

/**
 * Returns the unique set of `op://` references that appear as values in
 * `env`. Order follows iteration order of the input map.
 */
export function findOpRefs(env: EnvMap): string[] {
    const seen = new Set<string>();
    const refs: string[] = [];

    for (const value of Object.values(env)) {
        if (isOpRef(value) && !seen.has(value)) {
            seen.add(value);
            refs.push(value);
        }
    }

    return refs;
}

/**
 * True when any value in `env` is an `op://` reference.
 */
export function hasOpRef(env: EnvMap): boolean {
    for (const value of Object.values(env)) {
        if (isOpRef(value)) {
            return true;
        }
    }

    return false;
}

/**
 * Returns a new env map where each `op://` value has been replaced with the
 * value from `resolved`. Values for refs missing from `resolved` are left
 * intact (caller is responsible for noticing). Non-string values pass
 * through.
 */
export function replaceOpRefs(
    env: EnvMap,
    resolved: ReadonlyMap<string, string>,
): EnvMap {
    const out: EnvMap = {};

    for (const [key, value] of Object.entries(env)) {
        if (isOpRef(value)) {
            const replacement = resolved.get(value);
            out[key] = replacement === undefined ? value : replacement;
        }
        else {
            out[key] = value;
        }
    }

    return out;
}

/**
 * Returns a new env map with every key matching `SECRET_RESOLVER_*` removed.
 * The original map is not mutated.
 */
export function stripInternalEnvVars(env: EnvMap): EnvMap {
    const out: EnvMap = {};

    for (const [key, value] of Object.entries(env)) {
        if (!INTERNAL_VAR_PATTERN.test(key)) {
            out[key] = value;
        }
    }

    return out;
}

/**
 * Parses the per-launch `SECRET_RESOLVER_MODE` value into a
 * `SecretResolverMode`, taking the launch `console` into account for the
 * default. Explicit `"cache"` or `"op"` are honored regardless of console.
 * Missing / empty / unknown values default to `"cache"` for
 * `console === "internalConsole"` (where `op run` cannot be wrapped) and
 * `"op"` everywhere else. Unknown non-empty values produce a `console.warn`
 * so typos surface during development.
 */
export function parseSecretResolverMode(
    value: string | null | undefined,
    consoleKind: string,
): SecretResolverMode {
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();

        if (normalized === "cache") {
            return "cache";
        }

        if (normalized === "op") {
            return "op";
        }

        if (normalized !== "") {
            console.warn(
                `[secret-resolver] unknown SECRET_RESOLVER_MODE value ${
                    JSON.stringify(value)
                }; using console-derived default`,
            );
        }
    }

    return consoleKind === "internalConsole" ? "cache" : "op";
}

/**
 * Merges an envFile map (parsed externally) with an inline-env map. Inline
 * values win on key collision, matching VS Code's documented native behavior
 * for envFile + env in launch configs.
 */
export function mergeEnv(
    fileMap: StringEnvMap,
    inlineMap: EnvMap | undefined,
): EnvMap {
    return { ...fileMap, ...(inlineMap ?? {}) };
}
