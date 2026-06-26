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
 * Thrown when an `op` command exits non-zero or produces unusable output. The
 * stderr text is preserved so the caller can surface it to the user verbatim.
 */
export class OpCliError extends Error {
    readonly stderr: string
    readonly exitCode: number | null

    constructor(message: string, stderr: string, exitCode: number | null) {
        super(message)
        this.name = "OpCliError"
        this.stderr = stderr
        this.exitCode = exitCode
    }
}

/**
 * Thrown when `op inject` fails.
 */
export class OpInjectError extends OpCliError {
    constructor(message: string, stderr: string, exitCode: number | null) {
        super(message, stderr, exitCode)
        this.name = "OpInjectError"
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

/**
 * Classified `execFile` failure, shared by the inject and CLI error
 * normalizers so the ENOENT / abort / stderr handling lives in one place.
 */
type OpExecFailure =
    | { kind: "notFound"; error: OpCliNotFoundError }
    | { kind: "aborted"; error: Error }
    | { kind: "failed"; detail: string; stderr: string; exitCode: number | null }

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
            const empty = new Map<string, string>()
            return empty
        }

        const uuid = randomUUID()
        const template = OpRunner.buildTemplate(refs, uuid)
        // `op inject` reads the template from a file. Passing it on stdin does
        // not work when spawned from Node: the child's stdin is an AF_UNIX
        // socketpair (not a real pipe), which `op` does not accept as piped
        // input ("expected data on stdin but none found"). We write the
        // template — which holds only `op://` references, never secrets — to a
        // `0600`-ish temp file and pass it via `--in-file`, then remove it.
        const directory = await mkdtemp(path.join(os.tmpdir(), "secret-resolver-"))
        const file = path.join(directory, "template")

        try {
            await writeFile(file, template, "utf8")

            const env = options.token !== undefined
                ? { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: options.token }
                : undefined

            const { stdout } = await execFileAsync(
                this.opPath,
                [...OpRunner.accountArgs(options.account), "inject", "--in-file", file],
                {
                    signal: options.signal,
                    encoding: "utf8",
                    maxBuffer: 64 * 1_024 * 1_024,
                    ...(env !== undefined ? { env } : {}),
                },
            )

            const resolved = OpRunner.parseOutput(stdout, refs, uuid)
            return resolved
        }
        catch (err) {
            throw OpRunner.normalizeInjectError(err, this.opPath)
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    }

    /**
     * Runs `op account list --format json` and returns the typed account list.
     * Entries without both an email and a non-empty `account_uuid` are dropped.
     */
    async listAccounts(options: OpBaseOptions): Promise<OpAccount[]> {
        const raw = await this.execJson<Array<{ email?: string; account_uuid?: string }>>(
            ["account", "list", "--format", "json"],
            options,
            "op account list returned non-JSON output",
        )

        const accounts: OpAccount[] = []

        for (const entry of raw) {
            if (
                typeof entry.email === "string"
                && typeof entry.account_uuid === "string"
                && entry.account_uuid !== ""
            ) {
                accounts.push({ email: entry.email, accountUuid: entry.account_uuid })
            }
        }

        return accounts
    }

    /**
     * Runs `op item list --tags <tag> --categories "API Credential" --format json`.
     * Always strips any inherited `OP_SERVICE_ACCOUNT_TOKEN` from the child env.
     */
    async listItems(tag: string, options: OpListItemsOptions): Promise<OpItemSummary[]> {
        const args = [
            ...OpRunner.accountArgs(options.account),
            "item",
            "list",
            "--tags",
            tag,
            "--categories",
            "API Credential",
            "--format",
            "json",
        ]

        const raw = await this.execJson<Array<{ id?: string; vault?: { id?: string } }>>(
            args,
            { signal: options.signal, stripServiceAccountToken: true },
            "op item list returned non-JSON output",
        )

        const items: OpItemSummary[] = []

        for (const entry of raw) {
            const vaultId = entry.vault?.id

            if (typeof entry.id === "string" && typeof vaultId === "string") {
                items.push({ id: entry.id, vaultId })
            }
        }

        return items
    }

    /**
     * Runs `op item get <itemId> --vault <vaultId> --fields label=credential --format json`.
     * Always strips any inherited `OP_SERVICE_ACCOUNT_TOKEN` from the child env.
     * Returns the credential field value, or `null` when the field is missing
     * or empty.
     */
    async getItemCredential(
        itemId: string,
        vaultId: string,
        options: OpGetItemOptions,
    ): Promise<string | null> {
        const args = [
            ...OpRunner.accountArgs(options.account),
            "item",
            "get",
            itemId,
            "--vault",
            vaultId,
            "--fields",
            "label=credential",
            "--format",
            "json",
        ]

        const parsed = await this.execJson<unknown>(
            args,
            { signal: options.signal, stripServiceAccountToken: true },
            "op item get returned non-JSON output",
        )

        const fields = Array.isArray(parsed)
            ? (parsed as Array<{ value?: unknown }>)
            : [parsed as { value?: unknown }]
        const value = fields[0]?.value
        const credential = typeof value === "string" && value !== "" ? value : null
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
        const result = [
            this.opPath,
            "run",
            ...OpRunner.accountArgs(account),
            `--env-file=${envFilePath}`,
            "--",
            ...args,
        ]
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
            ? OpRunner.withoutServiceAccountToken(process.env)
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
            throw OpRunner.normalizeCliError(err, this.opPath)
        }

        try {
            const parsed = JSON.parse(stdout) as T
            return parsed
        }
        catch {
            throw new OpCliError(parseErrorMessage, stdout, null)
        }
    }
    // -----------------------------------------------------------------------
    // Private static helpers
    // -----------------------------------------------------------------------

    /**
     * Returns `["--account", <id>]` when `account` is a non-blank string, or
     * an empty array otherwise. The `op` CLI accepts `--account` as a global
     * flag, so callers can splice the result before or after the subcommand.
     */
    private static accountArgs(account: string | undefined): string[] {
        if (account === undefined || account.trim() === "") {
            const empty: string[] = []
            return empty
        }

        const args = ["--account", account]
        return args
    }

    private static withoutServiceAccountToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        const childEnv = { ...env }
        delete childEnv.OP_SERVICE_ACCOUNT_TOKEN
        return childEnv
    }

    /**
     * Classifies an `execFile` failure into not-found / aborted / failed so
     * the two normalizers below share the ENOENT, abort, and stderr handling.
     */
    private static classifyExecError(err: unknown, opPath: string): OpExecFailure {
        if (typeof err !== "object" || err === null) {
            const failure: OpExecFailure = {
                kind: "failed",
                detail: String(err),
                stderr: "",
                exitCode: null,
            }
            return failure
        }

        const error = err as NodeJS.ErrnoException & { stderr?: string | Buffer; code?: string | number }

        if (error.code === "ENOENT") {
            const failure: OpExecFailure = {
                kind: "notFound",
                error: new OpCliNotFoundError(opPath),
            }
            return failure
        }

        if (error.name === "AbortError" || error.code === "ABORT_ERR") {
            const failure: OpExecFailure = { kind: "aborted", error: error as Error }
            return failure
        }

        const stderr = OpRunner.extractStderr(error)
        const exitCode = typeof error.code === "number" ? error.code : null
        const detail = stderr.length > 0 ? stderr : error.message
        const failure: OpExecFailure = { kind: "failed", detail, stderr, exitCode }
        return failure
    }

    /**
     * Error normalizer for `inject`. Wraps AbortError in `OpInjectAbortedError`
     * so callers can distinguish cancellation without depending on AbortSignal.
     * Contrast with `normalizeCliError`, which re-throws AbortError as-is.
     */
    private static normalizeInjectError(err: unknown, opPath: string): Error {
        const failure = OpRunner.classifyExecError(err, opPath)

        if (failure.kind === "notFound") {
            return failure.error
        }

        if (failure.kind === "aborted") {
            const aborted = new OpInjectAbortedError()
            return aborted
        }

        const injectError = new OpInjectError(
            `op inject failed: ${failure.detail}`,
            failure.stderr,
            failure.exitCode,
        )
        return injectError
    }

    /**
     * Error normalizer for account/item CLI calls. Re-throws AbortError as-is so
     * callers can detect cancellation via AbortSignal. Contrast with
     * `normalizeInjectError`, which wraps AbortError in `OpInjectAbortedError`.
     */
    private static normalizeCliError(err: unknown, opPath: string): Error {
        const failure = OpRunner.classifyExecError(err, opPath)

        if (failure.kind === "notFound" || failure.kind === "aborted") {
            return failure.error
        }

        const cliError = new OpCliError(
            `op failed: ${failure.detail}`,
            failure.stderr,
            failure.exitCode,
        )
        return cliError
    }

    private static extractStderr(
        error: NodeJS.ErrnoException & { stderr?: string | Buffer },
    ): string {
        const raw = error.stderr instanceof Buffer
            ? error.stderr.toString("utf8")
            : typeof error.stderr === "string"
            ? error.stderr
            : ""
        const trimmed = raw.trim()
        return trimmed
    }

    private static buildTemplate(refs: readonly string[], uuid: string): string {
        const lines: string[] = []

        for (let i = 0; i < refs.length; i += 1) {
            lines.push(`__SR_${uuid}_BEGIN_${i}__`)
            lines.push(`{{ ${refs[i]} }}`)
            lines.push(`__SR_${uuid}_END_${i}__`)
        }

        const template = `${lines.join("\n")}\n`
        return template
    }

    private static parseOutput(
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
}
