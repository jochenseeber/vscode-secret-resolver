import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thrown when the `op` binary cannot be located at the configured path.
 */
export class OpCliNotFoundError extends Error {
    readonly opPath: string;

    constructor(opPath: string) {
        super(
            `1Password CLI not found at "${opPath}". Set secretResolver.opPath or install the CLI.`,
        );
        this.name = "OpCliNotFoundError";
        this.opPath = opPath;
    }
}

/**
 * Thrown when `op inject` exits non-zero. The stderr text is preserved so
 * the caller can surface it to the user verbatim.
 */
export class OpInjectError extends Error {
    readonly stderr: string;
    readonly exitCode: number | null;

    constructor(message: string, stderr: string, exitCode: number | null) {
        super(message);
        this.name = "OpInjectError";
        this.stderr = stderr;
        this.exitCode = exitCode;
    }
}

/**
 * Thrown when the spawn was aborted via the supplied AbortSignal (e.g. the
 * user cancelled the launch). Distinguished from `OpInjectError` so the
 * caller can suppress error UI for cancellations.
 */
export class OpInjectAbortedError extends Error {
    constructor() {
        super("op inject aborted");
        this.name = "OpInjectAbortedError";
    }
}

/**
 * Resolves a list of `op://` references in one batched `op inject` call.
 * Returns a Map keyed by the original ref string. Each value is wrapped
 * between unique BEGIN/END markers so resolved values containing newlines
 * round-trip cleanly.
 */
export interface OpInjectRunner {
    resolve(
        refs: readonly string[],
        opPath: string,
        signal?: AbortSignal,
    ): Promise<Map<string, string>>;
}

/**
 * Default runner: writes the sentinel-wrapped template to a temp file and
 * runs `<opPath> inject --in-file <path>`. Using `--in-file` avoids any
 * stdin piping and lets us drive the spawn through the standard
 * `promisify(execFile)` API. The temp file holds only `op://` references —
 * not secrets — and is removed before this method returns.
 */
export class DefaultOpInjectRunner implements OpInjectRunner {
    async resolve(
        refs: readonly string[],
        opPath: string,
        signal?: AbortSignal,
    ): Promise<Map<string, string>> {
        if (refs.length === 0) {
            return new Map();
        }

        const uuid = randomUUID();
        const template = buildTemplate(refs, uuid);
        const dir = await mkdtemp(path.join(os.tmpdir(), "secret-resolver-"));
        const file = path.join(dir, "template");

        try {
            await writeFile(file, template, "utf8");
            const { stdout } = await execFileAsync(
                opPath,
                ["inject", "--in-file", file],
                {
                    signal,
                    encoding: "utf8",
                    maxBuffer: 64 * 1024 * 1024,
                },
            );
            return parseOutput(stdout, refs, uuid);
        }
        catch (err) {
            throw normalizeError(err, opPath);
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
}

function buildTemplate(refs: readonly string[], uuid: string): string {
    const lines: string[] = [];

    for (let i = 0; i < refs.length; i += 1) {
        lines.push(`__SR_${uuid}_BEGIN_${i}__`);
        lines.push(`{{ ${refs[i]} }}`);
        lines.push(`__SR_${uuid}_END_${i}__`);
    }

    return `${lines.join("\n")}\n`;
}

function parseOutput(
    stdout: string,
    refs: readonly string[],
    uuid: string,
): Map<string, string> {
    const out = new Map<string, string>();
    const pattern = new RegExp(
        `__SR_${uuid}_BEGIN_(\\d+)__\\n([\\s\\S]*?)\\n__SR_${uuid}_END_\\1__`,
        "g",
    );

    for (const match of stdout.matchAll(pattern)) {
        const idx = Number(match[1]);
        const value = match[2];

        if (idx >= 0 && idx < refs.length) {
            out.set(refs[idx], value);
        }
    }

    return out;
}

function normalizeError(err: unknown, opPath: string): Error {
    if (typeof err !== "object" || err === null) {
        return new OpInjectError(String(err), "", null);
    }

    const e = err as NodeJS.ErrnoException & {
        stderr?: string | Buffer;
        code?: string | number;
    };

    if (e.code === "ENOENT") {
        return new OpCliNotFoundError(opPath);
    }

    if (e.name === "AbortError" || e.code === "ABORT_ERR") {
        return new OpInjectAbortedError();
    }

    const stderr = e.stderr instanceof Buffer
        ? e.stderr.toString("utf8")
        : typeof e.stderr === "string"
        ? e.stderr
        : "";
    const trimmed = stderr.trim();
    const exitCode = typeof e.code === "number" ? e.code : null;
    const message = trimmed.length > 0
        ? `op inject failed: ${trimmed}`
        : `op inject failed: ${e.message}`;
    return new OpInjectError(message, stderr, exitCode);
}
