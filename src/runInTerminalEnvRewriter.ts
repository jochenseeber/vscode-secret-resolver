import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { DebugProtocol } from "@vscode/debugprotocol"
import { formatDotenv } from "./dotenv"
import type { StringEnvMap } from "./envHelpers"
import { buildOpRunArgs } from "./launchRewrite"
import type { SecretResolverSessionConfig } from "./sessionConfig"

export type ServiceAccountTokenProvider = (tag: string) => string | undefined

export class RunInTerminalEnvRewriter {
    constructor(
        private readonly getServiceAccountToken: ServiceAccountTokenProvider,
        private readonly processPid: number = process.pid,
    ) {}

    rewrite(
        message: DebugProtocol.RunInTerminalRequest,
        opPath: string,
        sessionConfig: SecretResolverSessionConfig | undefined,
    ): string | undefined {
        const stringEnv = toStringEnv(message.arguments.env)

        if (Object.keys(stringEnv).length === 0) {
            return undefined
        }

        let createdDir: string | undefined

        try {
            const dir = fs.mkdtempSync(
                path.join(os.tmpdir(), "secret-resolver-"),
            )
            createdDir = dir

            const accountId = sessionConfig?.accountId
            const envFilePath = path.join(dir, "env")

            fs.writeFileSync(envFilePath, formatDotenv(stringEnv), {
                mode: 0o600,
            })
            fs.writeFileSync(path.join(dir, ".pid"), String(this.processPid), {
                mode: 0o600,
            })

            const token = sessionConfig?.tokenTag !== undefined
                ? this.getServiceAccountToken(sessionConfig.tokenTag)
                : undefined

            if (token !== undefined) {
                const tokenEnvFilePath = path.join(dir, "token.env")
                fs.writeFileSync(
                    tokenEnvFilePath,
                    formatDotenv({ OP_SERVICE_ACCOUNT_TOKEN: token }),
                    { mode: 0o600 },
                )

                const innerArgs = buildOpRunArgs(opPath, envFilePath, message.arguments.args, accountId)
                message.arguments.args = buildOpRunArgs(opPath, tokenEnvFilePath, innerArgs, accountId)
            }
            else {
                message.arguments.args = buildOpRunArgs(
                    opPath,
                    envFilePath,
                    message.arguments.args,
                    accountId,
                )
            }

            message.arguments.env = {}
            return dir
        }
        catch (err) {
            if (createdDir !== undefined) {
                try {
                    fs.rmSync(createdDir, { recursive: true, force: true })
                }
                catch {
                    // best-effort
                }
            }

            console.error(
                `[secret-resolver] runInTerminal rewrite failed: ${(err as Error).message}`,
            )
            return undefined
        }
    }
}

function toStringEnv(
    env: Record<string, string | null> | undefined,
): StringEnvMap {
    const out: StringEnvMap = {}

    if (env === undefined || env === null) {
        return out
    }

    for (const [key, value] of Object.entries(env)) {
        if (typeof value === "string") {
            out[key] = value
        }
    }

    return out
}
