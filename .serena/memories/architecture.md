# Architecture

## Source Files (`src/`)

### Pure helpers (no `vscode` import — unit-testable in isolation)

| File | Responsibility |
|---|---|
| `envHelpers.ts` | `OP_REF_PATTERN`, `findOpRefs`, `hasOpRef`, `replaceOpRefs`, `stripInternalEnvVars`, `parseSecretResolverMode`, `parseSignalOnStop`, `mergeEnv`, env-var name constants, `SignalName`/`SignalStep` types |
| `dotenv.ts` | `.env` file parser (`parseEnvFile`) + writer (`formatDotenv`); `EnvFileNotFoundError` |
| `launchRewrite.ts` | `isRunInTerminalRequest` (DAP type guard), `buildOpRunArgs` (assembles `op run` argv) |
| `secretCache.ts` | `SecretCache` — session-scoped AES-256-GCM obfuscated in-memory cache; HMAC-SHA256 keys |
| `resolverCache.ts` | Namespace helpers over `SecretCache`: `getCachedToken/setCachedToken`, `getCachedAccountId/setCachedAccountId`, `getCachedResolvedRef/setCachedResolvedRef` — encapsulate key prefixes (`__token__:`, `__account__:`, etc.) |
| `opCli.ts` | `OpCli` class wrapping `execFile` for 1Password CLI calls; `execJson` handles spawn, parse, error normalisation via `normalizeOpCliError` |
| `opInject.ts` | `DefaultOpInjectRunner` — batched `op inject --in-file` with sentinel markers; `OpCliNotFoundError`, `OpInjectError`, `OpInjectAbortedError`; exported `normalizeOpCliError` |
| `accountResolver.ts` | `resolveAccountForEmail`, `resolveAccountForGitConfig`; two-layer cache (gitEmailStore + SecretCache); `AccountNotFoundError`, `GitEmailNotFoundError`, `GitEmailStore` interface |
| `tokenResolver.ts` | `resolveTokenForTag` (two `op` CLI calls: item list → item get); `getCachedToken` re-export; `TokenNotFoundError`, `TokenCredentialMissingError` |
| `resolveLaunchConfig.ts` | Orchestrator: merges env+envFile, reads mode/account/token/signal config, branches to op-run or cache path, assembles `SecretResolverSessionConfig` into `__secretResolver` field |
| `sessionConfig.ts` | `SecretResolverSessionConfig`, `SECRET_RESOLVER_CONFIG_FIELD`, `buildSessionConfig`, `parseSessionConfig`, `isSignalStep` |
| `processTree.ts` | `defaultGetProcessTree` (pidtree + `/proc` or `ps`), `isOpRunCommand`; `ProcessInfo`, `GetProcessTreeFn` |
| `tempDirRegistry.ts` | `InMemoryTempDirRegistry`, `cleanupRegistry`, `sweepStaleTempDirs` |
| `stopSignalController.ts` | `StopSignalController` — captures PID from runInTerminal response, dispatches signal sequence on DAP disconnect; `NODE_SIGNALS`, `toNodeSignal`; `KillFn` type |
| `runInTerminalEnvRewriter.ts` | `RunInTerminalEnvRewriter` — writes env/token dotenv files to temp dir, rewrites `runInTerminal` args to `op run --env-file`; `ServiceAccountTokenProvider` type |

### VS Code-aware layer

| File | Responsibility |
|---|---|
| `configProvider.ts` | `SecretDebugConfigurationProvider` — bridges `CancellationToken`→`AbortSignal`, reads `secretResolver.opPath`; `WorkspaceStateGitEmailStore` (gitEmailStore backed by `workspaceState`); `createDefaultProvider`, `createGitEmailStore` |
| `debugAdapterProxy.ts` | `SecretDebugAdapterTracker` + `SecretDebugAdapterTrackerFactory` — per-session DAP tracker; delegates env rewriting to `RunInTerminalEnvRewriter` and signal dispatch to `StopSignalController`; `TempDirRegistry` interface |
| `extension.ts` | Activation: creates `SecretCache`, `InMemoryTempDirRegistry`, `GitEmailStore`; grouped into `ExtensionState`; registers config provider, tracker factory, `secretResolver.clearCache` command, `onDidChangeConfiguration` listener; installs process signal handlers |

## Key Data Flows

1. **Config resolution**: `configProvider` → `resolveLaunchConfig` → `resolveAllRefs` (via `opInject`) or op-run path
2. **Token resolution**: `resolveLaunchConfig` → `tokenResolver.resolveTokenForTag` → `opCli.execJson` (twice)
3. **Account resolution**: `resolveLaunchConfig` → `accountResolver.resolveAccount*` → `opCli.execJson`
4. **Env rewriting**: DAP tracker → `RunInTerminalEnvRewriter.rewrite` → temp dir with dotenv files → `buildOpRunArgs`
5. **Signal-on-stop**: DAP tracker → `StopSignalController` → `processTree.defaultGetProcessTree` → `kill(pid, signal)`

## Temp Dir Security

Temp dirs are `0700`, env files are `0600`. A `.pid` file records the extension host PID for stale-dir sweeps at next activation. Token env files (for double `op run` wraps) are also `0600` in the same dir.
