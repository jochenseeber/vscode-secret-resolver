import * as vscode from "vscode"

import { type AccountResolverFactory, EmailAccountResolver, GitConfigAccountResolver } from "./accountResolver"

import { DotenvFile } from "./dotenv"
import { GitRunner } from "./gitRunner"
import { ConsoleLogger, type Logger } from "./logger"
import { OpRunner } from "./opRunner"
import { type EnvFileReader, LaunchConfigResolver, type WorkspaceTrustReader } from "./resolveLaunchConfig"
import { ResolverCache } from "./resolverCache"
import type { SecretCache } from "./secretCache"
import { TagTokenResolver, type TokenResolverFactory } from "./tokenResolver"
import { WindowUserNotifier } from "./vscodeAdapters"

export class SecretDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    private readonly cache: SecretCache
    private readonly logger: Logger
    private resolver: LaunchConfigResolver

    constructor(cache: SecretCache, logger: Logger = new ConsoleLogger()) {
        this.cache = cache
        this.logger = logger
        this.resolver = this.buildResolver()
    }

    /**
     * Rebuilds the launch-config resolver, re-reading `secretResolver.opPath`.
     * Called when the setting changes.
     */
    refreshResolver(): void {
        this.resolver = this.buildResolver()
    }

    private buildResolver(): LaunchConfigResolver {
        const opPath = vscode.workspace
            .getConfiguration("secretResolver")
            .get<string>("opPath", "op")
        const opRunner = new OpRunner(opPath)
        const gitRunner = new GitRunner()
        const resolverCache = new ResolverCache(this.cache)
        const notifier = new WindowUserNotifier()

        const envFileReader: EnvFileReader = {
            parse: (path) => new DotenvFile(path).parseFile(),
        }

        const workspaceTrust: WorkspaceTrustReader = {
            isTrusted: () => vscode.workspace.isTrusted,
        }

        const accountResolverFactory: AccountResolverFactory = {
            createForEmail: (email) => new EmailAccountResolver(email, opRunner, resolverCache),
            createForGitConfig: (subdirectory, workspacePath) =>
                new GitConfigAccountResolver(
                    subdirectory,
                    opRunner,
                    gitRunner,
                    resolverCache,
                    workspacePath,
                ),
        }

        const tokenResolverFactory: TokenResolverFactory = {
            createForTag: (tag) => new TagTokenResolver(tag, opRunner, resolverCache, this.logger),
        }

        const launchResolver = new LaunchConfigResolver(
            resolverCache,
            opRunner,
            envFileReader,
            notifier,
            accountResolverFactory,
            tokenResolverFactory,
            workspaceTrust,
        )
        return launchResolver
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
        token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const controller = new AbortController()
        const subscription = token?.onCancellationRequested(() => {
            controller.abort()
        })

        try {
            const resolved = await this.resolver.resolve(
                debugConfiguration,
                folder?.uri.fsPath,
                controller.signal,
            )
            return resolved
        }
        finally {
            subscription?.dispose()
        }
    }
}
