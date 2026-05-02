import { OpCliNotFoundError, OpInjectError } from "./opInject"

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { SecretCache } from "./secretCache"

const execFileAsync = promisify(execFile)

export class TokenNotFoundError extends Error {
    constructor(tag: string) {
        super(`No "API Credential" vault item found with tag "${tag}".`)
        this.name = "TokenNotFoundError"
    }
}

export class TokenCredentialMissingError extends Error {
    constructor(itemId: string) {
        super(
            `Vault item "${itemId}" has no "credential" field. Add a "credential" field containing the service account token.`,
        )
        this.name = "TokenCredentialMissingError"
    }
}

const CACHE_KEY_PREFIX = "__token__:"

/**
 * Resolves the service account token for `tag` by querying the 1Password CLI.
 * Caches the result under `__token__:<tag>` in `cache` so subsequent launches
 * with the same tag skip the CLI calls. Throws on any failure.
 */
export async function resolveTokenForTag(
    tag: string,
    opPath: string,
    cache: SecretCache,
    signal?: AbortSignal,
    account?: string,
): Promise<string> {
    const cacheKey = CACHE_KEY_PREFIX + tag
    const cached = cache.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const itemId = await findItemIdForTag(tag, opPath, signal, account)
    const token = await getCredentialField(itemId.id, itemId.vaultId, opPath, signal, account)

    cache.set(cacheKey, token)
    return token
}

async function findItemIdForTag(
    tag: string,
    opPath: string,
    signal: AbortSignal | undefined,
    account: string | undefined,
): Promise<{ id: string; vaultId: string }> {
    let stdout: string
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.OP_SERVICE_ACCOUNT_TOKEN

    try {
        ;({ stdout } = await execFileAsync(
            opPath,
            [
                "item",
                "list",
                ...(account ? ["--account", account] : []),
                "--tags",
                tag,
                "--categories",
                "API Credential",
                "--format",
                "json",
            ],
            { signal, encoding: "utf8", env: childEnv },
        ))
    }
    catch (err) {
        throw normalizeExecError(err, opPath)
    }

    let items: Array<{ id?: string; vault?: { id?: string } }>

    try {
        items = JSON.parse(stdout) as Array<{ id?: string; vault?: { id?: string } }>
    }
    catch {
        throw new OpInjectError("op item list returned non-JSON output", stdout, null)
    }

    if (!Array.isArray(items) || items.length === 0) {
        throw new TokenNotFoundError(tag)
    }

    const item = items[0]
    const id = item.id
    const vaultId = item.vault?.id

    if (typeof id !== "string" || typeof vaultId !== "string") {
        throw new TokenNotFoundError(tag)
    }

    return { id, vaultId }
}

async function getCredentialField(
    itemId: string,
    vaultId: string,
    opPath: string,
    signal: AbortSignal | undefined,
    account: string | undefined,
): Promise<string> {
    let stdout: string
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.OP_SERVICE_ACCOUNT_TOKEN

    try {
        ;({ stdout } = await execFileAsync(
            opPath,
            [
                "item",
                "get",
                itemId,
                ...(account ? ["--account", account] : []),
                "--vault",
                vaultId,
                "--fields",
                "label=credential",
                "--format",
                "json",
            ],
            { signal, encoding: "utf8", env: childEnv },
        ))
    }
    catch (err) {
        throw normalizeExecError(err, opPath)
    }

    let fields: Array<{ value?: unknown }>

    try {
        const parsed = JSON.parse(stdout) as unknown
        // op item get --fields returns an array when --format json is used.
        fields = Array.isArray(parsed) ? (parsed as Array<{ value?: unknown }>) : [parsed as { value?: unknown }]
    }
    catch {
        throw new OpInjectError("op item get returned non-JSON output", stdout, null)
    }

    const value = fields[0]?.value

    if (typeof value !== "string" || value === "") {
        throw new TokenCredentialMissingError(itemId)
    }

    return value
}

function normalizeExecError(err: unknown, opPath: string): Error {
    if (typeof err !== "object" || err === null) {
        return new OpInjectError(String(err), "", null)
    }

    const e = err as NodeJS.ErrnoException & {
        stderr?: string | Buffer
        code?: string | number
    }

    if (e.code === "ENOENT") {
        return new OpCliNotFoundError(opPath)
    }

    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
        // Re-throw as-is so callers can detect cancellation via the abort signal.
        return e as Error
    }

    const stderr = e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : typeof e.stderr === "string"
        ? e.stderr
        : ""
    const trimmed = stderr.trim()
    const exitCode = typeof e.code === "number" ? e.code : null
    const message = trimmed.length > 0
        ? `op failed: ${trimmed}`
        : `op failed: ${e.message}`
    return new OpInjectError(message, stderr, exitCode)
}
