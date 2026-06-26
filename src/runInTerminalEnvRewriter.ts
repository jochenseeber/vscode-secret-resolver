import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { DebugProtocol } from "@vscode/debugprotocol"
import { DotenvFile } from "./dotenv"
import type { Logger } from "./logger"
import { type OpRunner } from "./opRunner"
import type { SecretResolverSessionConfig } from "./sessionConfig"
import { StringEnvMap } from "./stringEnvMap"
import { InMemoryTempDirRegistry } from "./tempDirRegistry"
import type { UserNotifier } from "./userNotifier"

export class RunInTerminalEnvRewriter {
    constructor(
        private readonly notifier: UserNotifier,
        private readonly logger: Logger,
        private readonly launchEnv: Record<string, string> = {},
        private readonly processPid: number = process.pid,
    ) {}

    rewrite(
        message: DebugProtocol.RunInTerminalRequest,
        runner: OpRunner,
        sessionConfig: SecretResolverSessionConfig | undefined,
    ): string | undefined {
        const envFileEntries = this.buildEnvFileEntries(message.arguments.env)

        if (envFileEntries.size === 0) {
            return undefined
        }

        const stringEnv = envFileEntries.toRecord()

        let createdDirectory: string | undefined

        try {
            const directory = fs.mkdtempSync(
                path.join(os.tmpdir(), "secret-resolver-"),
            )
            createdDirectory = directory

            const accountId = sessionConfig?.accountId
            const envFilePath = path.join(directory, "env")

            new DotenvFile(envFilePath).write(stringEnv)
            fs.writeFileSync(path.join(directory, ".pid"), String(this.processPid), {
                mode: 0o600,
            })

            message.arguments.args = runner.buildRunArgs(
                envFilePath,
                message.arguments.args,
                accountId,
            )

            message.arguments.env = {}
            return directory
        }
        catch (err) {
            if (createdDirectory !== undefined) {
                InMemoryTempDirRegistry.removeDirectoryQuietly(createdDirectory)
            }

            const detail = (err as Error).message
            this.logger.error(`runInTerminal rewrite failed: ${detail}`)
            this.notifier.showWarning(
                `Secret Resolver: could not prepare the terminal env file (${detail}); launching without the op run wrapper.`,
            )
            return undefined
        }
    }

    /**
     * Merges the launch config env with the DAP request env. The launch env
     * is the baseline so every launch variable moves into the env file, even
     * ones the adapter did not forward in the `runInTerminal` request.
     * Adapter-provided entries win on clashes (the adapter may have extended
     * a launch value, e.g. `NODE_OPTIONS`), and `null` entries (DAP "unset")
     * remove the variable.
     */
    private buildEnvFileEntries(
        requestEnv: Record<string, string | null> | undefined,
    ): StringEnvMap {
        const merged = new StringEnvMap(this.launchEnv)

        if (requestEnv === undefined || requestEnv === null) {
            return merged
        }

        for (const [key, value] of Object.entries(requestEnv)) {
            if (typeof value === "string") {
                merged.setValue(key, value)
            }
            else if (value === null) {
                merged.deleteKey(key)
            }
        }

        return merged
    }
}
