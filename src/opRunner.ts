import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the `op` binary cannot be located at the configured path.
 */
export class OpCliNotFoundError extends Error {
    readonly opPath: string

    constructor(opPath: string) {
        super(
            `1Password CLI not found at "${opPath}". Set secretResolver.opPath or install the CLI.`,
        )
        this.name = "OpCliNotFoundError"
        this.opPath = opPath
    }
}

/**
 * Thrown when an `op` command exits non-zero. The stderr text is preserved so
 * the caller can surface it to the user verbatim.
 */
export class OpInjectError extends Error {
    readonly stderr: string
    readonly exitCode: number | null

    constructor(message: string, stderr: string, exitCode: number | null) {
        super(message)
        this.name = "OpInjectError"
        this.stderr = stderr
        this.exitCode = exitCode
    }
}

/**
 * Thrown when `op inject` was aborted via the supplied AbortSignal (e.g. the
 * user cancelled the launch). Distinguished from `OpInjectError` so the caller
 * can suppress error UI for cancellations.
 */
export class OpInjectAbortedError extends Error {
    constructor() {
        super("op inject aborted")
        this.name = "OpInjectAbortedError"
    }
}

// ---------------------------------------------------------------------------
// Options and data types
// ---------------------------------------------------------------------------

export interface OpBaseOptions {
    signal?: AbortSignal
}

export interface OpInjectOptions extends OpBaseOptions {
    /** Passed as `OP_SERVICE_ACCOUNT_TOKEN` in the child env. */
    token?: string
    /** Passed as `--account` to the CLI. */
    account?: string
}

export interface OpListItemsOptions extends OpBaseOptions {
    /** Passed as `--account` to the CLI. */
    account?: string
}

export type OpGetItemOptions = OpListItemsOptions

export interface OpAccount {
    email: string
    accountUuid: string
}

export interface OpItemSummary {
    id: string
    vaultId: string
}

// ---------------------------------------------------------------------------
// OpRunner
// ---------------------------------------------------------------------------

export class OpRunner {
    constructor(readonly opPath: string) {}

    /**
     * Resolves a list of `op://` references in one batched `op inject` call.
     * Sentinel-wraps each ref so multi-line values round-trip cleanly.
     * Throws `OpInjectAbortedError` on abort, `OpCliNotFoundError` /
     * `OpInjectError` on other failures.
     */
    async inject(
        refs: readonly string[],
        options: OpInjectOptions = {},
    ): Promise<Map<string, string>> {
        if (refs.length === 0) {
            return new Map()
        }

        const uuid = randomUUID()
        const template = buildTemplate(refs, uuid)
        const dir = await mkdtemp(path.join(os.tmpdir(), "secret-resolver-"))
        const file = path.join(dir, "template")

        try {
            await writeFile(file, template, "utf8")

            const env = options.token !== undefined
                ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: options.token }
                : undefined

            const { stdout } = await execFileAsync(
                this.opPath,
                [
                    ...withAccount(["inject"], options.account),
                    "--in-file",
                    file,
                ],
                {
                    signal: options.signal,
                    encoding: "utf8",
                    maxBuffer: 64 * 1_024 * 1_024,
                    ...(env !== undefined ? { env } : {}),
                },
            )

            const resolved = parseOutput(stdout, refs, uuid)
            return resolved
        }
        catch (err) {
            throw normalizeInjectError(err, this.opPath)
        }
        finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    /**
     * Runs `op account list --format json` and returns the typed account list.
     */
    async listAccounts(options: OpBaseOptions): Promise<OpAccount[]> {
        const raw = await this.execJson<Array<{ email?: string; account_uuid?: string }>>(
            ["account", "list", "--format", "json"],
            options,
            "op account list returned non-JSON output",
        )

        const accounts = raw.map((entry) => ({
            email: typeof entry.email === "string" ? entry.email : "",
            accountUuid: typeof entry.account_uuid === "string" ? entry.account_uuid : "",
        }))
        return accounts
    }

    /**
     * Runs `op item list --tags <tag> --categories "API Credential" --format json`.
     * Always strips any inherited `OP_SERVICE_ACCOUNT_TOKEN` from the child env.
     */
    async listItems(tag: string, options: OpListItemsOptions): Promise<OpItemSummary[]> {
        const args = withAccount(
            ["item", "list", "--tags", tag, "--categories", "API Credential", "--format", "json"],
            options.account,
        )

        const raw = await this.execJson<Array<{ id?: string; vault?: { id?: string } }>>(
            args,
            { signal: options.signal, stripServiceAccountToken: true },
            "op item list returned non-JSON output",
        )

        const items = raw
            .filter((entry) => typeof entry.id === "string" && typeof entry.vault?.id === "string")
            .map((entry) => ({
                id: entry.id as string,
                vaultId: entry.vault!.id as string,
            }))
        return items
    }

    /**
     * Runs `op item get <itemId> --vault <vaultId> --fields label=credential --format json`.
     * Always strips any inherited `OP_SERVICE_ACCOUNT_TOKEN` from the child env.
     * Returns the credential field value.
     */
    async getItemCredential(
        itemId: string,
        vaultId: string,
        options: OpGetItemOptions,
    ): Promise<string> {
        const args = withAccount(
            ["item", "get", itemId, "--vault", vaultId, "--fields", "label=credential", "--format", "json"],
            options.account,
        )

        const parsed = await this.execJson<unknown>(
            args,
            { signal: options.signal, stripServiceAccountToken: true },
            "op item get returned non-JSON output",
        )

        const fields = Array.isArray(parsed)
            ? (parsed as Array<{ value?: unknown }>)
            : [parsed as { value?: unknown }]
        const value = fields[0]?.value
        const credential = typeof value === "string" ? value : ""
        return credential
    }

    /**
     * Returns the `runInTerminal` argv that wraps the launch in
     * `op run --env-file=<envFilePath> -- <origArgs>`.
     * Pure — no process is spawned.
     */
    buildRunArgs(
        envFilePath: string,
        args: readonly string[],
        account?: string,
    ): string[] {
        const accountArgs = (account !== undefined && account.trim() !== "")
            ? ["--account", account]
            : []
        const result = [this.opPath, "run", ...accountArgs, `--env-file=${envFilePath}`, "--", ...args]
        return result
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private async execJson<T>(
        args: string[],
        options: { signal?: AbortSignal; stripServiceAccountToken?: boolean },
        parseErrorMessage: string,
    ): Promise<T> {
        const env = options.stripServiceAccountToken === true
            ? withoutServiceAccountToken(process.env)
            : undefined

        let stdout: string

        try {
            const result = await execFileAsync(this.opPath, args, {
                signal: options.signal,
                encoding: "utf8",
                ...(env !== undefined ? { env } : {}),
            })
            stdout = result.stdout
        }
        catch (err) {
            throw normalizeCliError(err, this.opPath)
        }

        try {
            return JSON.parse(stdout) as T
        }
        catch {
            throw new OpInjectError(parseErrorMessage, stdout, null)
        }
    }
}

// ---------------------------------------------------------------------------
// Private module helpers
// ---------------------------------------------------------------------------

/**
 * Prepends `--account <id>` to `args` when account is set. The `op` CLI
 * accepts `--account` as a global flag before the subcommand.
 */
function withAccount(args: string[], account: string | undefined): string[] {
    if (account === undefined || account.trim() === "") {
        return args
    }

    const result = ["--account", account, ...args]
    return result
}

function withoutServiceAccountToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const childEnv = { ...env }
    delete childEnv.OP_SERVICE_ACCOUNT_TOKEN
    return childEnv
}

/**
 * Error normalizer for `inject`. Wraps AbortError in `OpInjectAbortedError`
 * so callers can distinguish cancellation without depending on AbortSignal.
 * Contrast with `normalizeCliError`, which re-throws AbortError as-is.
 */
function normalizeInjectError(err: unknown, opPath: string): Error {
    if (typeof err !== "object" || err === null) {
        return new OpInjectError(String(err), "", null)
    }

    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer; code?: string | number }

    if (e.code === "ENOENT") {
        return new OpCliNotFoundError(opPath)
    }

    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
        return new OpInjectAbortedError()
    }

    const stderr = extractStderr(e)
    const exitCode = typeof e.code === "number" ? e.code : null
    const message = stderr.length > 0
        ? `op inject failed: ${stderr}`
        : `op inject failed: ${e.message}`
    return new OpInjectError(message, stderr, exitCode)
}

/**
 * Error normalizer for account/item CLI calls. Re-throws AbortError as-is so
 * callers can detect cancellation via AbortSignal. Contrast with
 * `normalizeInjectError`, which wraps AbortError in `OpInjectAbortedError`.
 */
function normalizeCliError(err: unknown, opPath: string): Error {
    if (typeof err !== "object" || err === null) {
        return new OpInjectError(String(err), "", null)
    }

    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer; code?: string | number }

    if (e.code === "ENOENT") {
        return new OpCliNotFoundError(opPath)
    }

    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
        return e as Error
    }

    const stderr = extractStderr(e)
    const exitCode = typeof e.code === "number" ? e.code : null
    const message = stderr.length > 0
        ? `op failed: ${stderr}`
        : `op failed: ${e.message}`
    return new OpInjectError(message, stderr, exitCode)
}

function extractStderr(
    e: NodeJS.ErrnoException & { stderr?: string | Buffer },
): string {
    const raw = e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : typeof e.stderr === "string"
        ? e.stderr
        : ""
    return raw.trim()
}

function buildTemplate(refs: readonly string[], uuid: string): string {
    const lines: string[] = []

    for (let i = 0; i < refs.length; i += 1) {
        lines.push(`__SR_${uuid}_BEGIN_${i}__`)
        lines.push(`{{ ${refs[i]} }}`)
        lines.push(`__SR_${uuid}_END_${i}__`)
    }

    const template = `${lines.join("\n")}\n`
    return template
}

function parseOutput(
    stdout: string,
    refs: readonly string[],
    uuid: string,
): Map<string, string> {
    const out = new Map<string, string>()
    const pattern = new RegExp(
        `__SR_${uuid}_BEGIN_(\\d+)__\\n([\\s\\S]*?)\\n__SR_${uuid}_END_\\1__`,
        "g",
    )

    for (const match of stdout.matchAll(pattern)) {
        const idx = Number(match[1])
        const value = match[2]

        if (idx >= 0 && idx < refs.length) {
            out.set(refs[idx], value)
        }
    }

    return out
}
