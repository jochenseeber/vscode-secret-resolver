import { normalizeOpCliError, OpInjectError } from "./opInject"

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface OpCliExecOptions {
    signal?: AbortSignal
    account?: string
    withoutServiceAccountToken?: boolean
}

export interface OpCliJsonOptions extends OpCliExecOptions {
    parseErrorMessage: string
}

export class OpCli {
    constructor(private readonly opPath: string) {}

    async execText(
        args: readonly string[],
        options: OpCliExecOptions = {},
    ): Promise<string> {
        const env = options.withoutServiceAccountToken
            ? withoutServiceAccountToken(process.env)
            : undefined

        try {
            const { stdout } = await execFileAsync(
                this.opPath,
                withAccount(args, options.account),
                {
                    signal: options.signal,
                    encoding: "utf8",
                    ...(env === undefined ? {} : { env }),
                },
            )

            return stdout
        }
        catch (err) {
            throw normalizeOpCliError(err, this.opPath)
        }
    }

    async execJson<T>(
        args: readonly string[],
        options: OpCliJsonOptions,
    ): Promise<T> {
        const stdout = await this.execText(args, options)

        try {
            return JSON.parse(stdout) as T
        }
        catch {
            throw new OpInjectError(options.parseErrorMessage, stdout, null)
        }
    }
}

function withAccount(args: readonly string[], account: string | undefined): string[] {
    if (account === undefined || account.trim() === "") {
        return [...args]
    }

    if (args[0] === "item" && args[1] === "get" && args.length >= 3) {
        return ["item", "get", args[2], "--account", account, ...args.slice(3)]
    }

    if (args.length >= 2) {
        return [args[0], args[1], "--account", account, ...args.slice(2)]
    }

    return [...args, "--account", account]
}

function withoutServiceAccountToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const childEnv = { ...env }
    delete childEnv.OP_SERVICE_ACCOUNT_TOKEN
    return childEnv
}
