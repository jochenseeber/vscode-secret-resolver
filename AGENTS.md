# Agent Instructions

- MUST read `README.md` for project description and usage instructions.
- MUST add information for humans to `README.md`
- MUST add information for AI agents to `AGENTS.md`
- MUST keep both files non-redundant
- MUST use Serena when working with code

## Project Overview

This is a VS Code extension (`vscode-secret-resolver`) that resolves 1Password
`op://` secret references in debug-launch environment variables. There is a
single resolution path:

- The resolver runs `op inject` in-extension and caches the resolved plaintext
  obfuscated in memory for the duration of the VS Code session. The tracker
  wraps the launch in `op run --env-file` for terminal consoles (the env file
  holds plaintext, `op run` becomes a pass-through env loader that keeps the
  env off the command line). For `internalConsole` no terminal is involved, no
  temp file is written; the adapter receives plaintext directly via
  `config.env`.

`SECRET_RESOLVER_MODE` is obsolete: it is no longer read (an explicit value is
silently ignored) but is still stripped along with every other
`SECRET_RESOLVER_*` key.

For terminal consoles, the env never flows through DAP `arguments.env`
plaintext — it lives only in the temp file (mode `0600`) inside an `0700` temp
dir, and is removed on session end. Crashed-session leftovers are swept on next
activation by checking the dir's `.pid` file against live PIDs.

## Architecture

- `src/stringEnvMap.ts` — `StringEnvMap`, the env-map abstraction used
  throughout the resolver. Encapsulates an ordered `Map<string, string>`
  (private) and offers `addAll` (merge; later entries win), `getValue` /
  `getTrimmedValue`, `setValue`, `hasKey`, `deleteKey`, `deleteIf`, `filter`
  (into a new map), `some`, `forEach`, `valueList`, a `size` getter, and
  `toRecord`. Replaces the old free-function env helpers.
- `src/dotenv.ts` — `DotenvFile` class for a single file path
  (`constructor(path)`). Instance `parseFile()` reads + parses `this.path`
  (throws `EnvFileNotFoundError` for ENOENT so callers can warn and continue;
  rethrows other I/O errors); instance `write(env, mode = 0o600)` formats and
  writes synchronously (used by the tracker to produce files
  `op run --env-file` accepts). Static `parse(text)` (pure; tolerant of
  `export`, comments, blank lines, matched quotes, leading BOM) and
  `format(env)` (safe ASCII unquoted; everything else double-quoted with
  backslash escapes for `\`, `"`, `$`, `\n`, `\r`; throws `InvalidEnvKeyError`
  for keys that cannot round-trip — empty, containing `=` or whitespace, or
  starting with `#`). `EnvFileNotFoundError` and `InvalidEnvKeyError` are
  top-level exports.
- `src/secretCache.ts` — `SecretCache` class. Session-scoped 32-byte key in a
  closure-scoped `Buffer`, HMAC-SHA256 cache keys, AES-256-GCM encrypted values
  with per-entry IV. `clear()` zeroes the key buffer in place and rotates.
  Obfuscation, not real encryption — the goal is to defeat heap dumps and
  accidental log disclosure. The only class using `#` (runtime) private fields;
  everywhere else TypeScript `private` is the convention.
- `src/logger.ts` — `Logger` interface (`info`/`warn`/`error`) plus
  `ConsoleLogger` fallback. Pure modules log through an injected `Logger`
  instead of `console.*`.
- `src/userNotifier.ts` — `UserNotifier` interface (`showError` /
  `showWarning`) for user-facing popups, distinct from logging.
- `src/vscodeAdapters.ts` — `vscode`-backed implementations:
  `OutputChannelLogger` (wraps the `Secret Resolver` `LogOutputChannel` created
  on activation) and `WindowUserNotifier` (wraps `vscode.window` message
  popups).
- `src/resolverCache.ts` — `ResolverCache`, domain cache namespaces layered
  over `SecretCache`: resolved refs (`getResolvedRef` / `setResolvedRef`, both
  taking a `RefResolutionScope` of `{ accountId, tokenTag }` so a ref resolved
  under one account/token context is never served under another), service
  account tokens (`getToken` / `setToken`), and account IDs (`getAccountId` /
  `setAccountId`). Keep synthetic key naming here; callers should not construct
  cache keys directly. Resolver classes take a `ResolverCache` via constructor
  injection (built once per `LaunchConfigResolver` in `configProvider.ts`).
- `src/accountResolver.ts` — Account resolution; no `vscode` import. Exports
  the `AccountResolver` abstract class
  (`resolve(signal?) => Promise<string | null>`), the `AccountResolverFactory`
  interface (`createForEmail` / `createForGitConfig`, implemented by
  `configProvider.ts`), and the implementations `GitConfigAccountResolver`
  (reads `user.email` via `GitRunner`, then looks up the account UUID),
  `EmailAccountResolver` (account UUID from a plain email),
  `LiteralAccountResolver` (uses a literal account id verbatim — used for
  `SECRET_RESOLVER_ACCOUNT_ID`), and `NullAccountResolver` (returns `null`).
  Each class owns its resolution logic (no free helper functions); the
  resolvers take a `ResolverCache` (not a raw `SecretCache`).
  `EmailAccountResolver` runs `op account list --format json` via
  `OpRunner.listAccounts`, matches by email (case-insensitive), and caches the
  email → UUID. `GitConfigAccountResolver` runs `git config --get user.email`
  on every launch (the email is not cached) then delegates to an
  `EmailAccountResolver`; `subdirectory` must be relative (`.` = workspace
  root) and must resolve below the workspace (no `..` traversal outside it).
  Error classes: `AccountNotFoundError`, `GitEmailNotFoundError`.
- `src/tokenResolver.ts` — Service-account-token resolution; no `vscode`
  import. `TokenResolver` abstract class
  (`resolve(account?, signal?) => Promise<string | null>`), the
  `TokenResolverFactory` interface (`createForTag`, implemented by
  `configProvider.ts`), and the implementations `TagTokenResolver` (resolves a
  tag's token via two `OpRunner` JSON calls — `listItems` for the tagged "API
  Credential" item, then `getItemCredential` for its `credential` field) and
  `NullTokenResolver` (returns `null`). `TagTokenResolver` takes a
  `ResolverCache` plus a `Logger`, caches the token in the token namespace, and
  logs a warning when several items carry the tag (first one wins). Error
  classes: `TokenNotFoundError` (empty item list),
  `TokenCredentialMissingError` (`getItemCredential` returned `null`).
- `src/opRunner.ts` — `OpRunner`, the single wrapper over the 1Password CLI.
  `inject(refs, options)` runs `<opPath> inject --in-file <tempfile>`, writing
  a sentinel-wrapped (`__SR_<uuid>_BEGIN_<n>__` / `__SR_<uuid>_END_<n>__`)
  template to a temp file (removed after) and parsing stdout. The template
  holds only `op://` references, not secrets; stdin is not used because Node's
  spawned child stdin is an AF_UNIX socketpair that `op` rejects as piped
  input. `options` carries an optional `token` (passed as
  `OP_SERVICE_ACCOUNT_TOKEN` in the child env) and `account` (passed as
  `--account`). `listAccounts`, `listItems`, and `getItemCredential` run the
  JSON `op account`/`op item` commands via `execJson` (strips any inherited
  `OP_SERVICE_ACCOUNT_TOKEN`, inserts `--account` when set).
  `buildRunArgs(envFilePath,
  args, account?)` returns the pure
  `op run --env-file=<file> [--account <id>] -- <args>` argv; the `--account`
  pair comes from the shared `accountArgs` helper. `getItemCredential` returns
  `null` for a missing/empty credential; `listAccounts` drops entries without
  both an email and a non-empty `account_uuid`. Error classes:
  `OpCliNotFoundError`, `OpCliError` (generic CLI failure), `OpInjectError`
  (extends `OpCliError`; inject failures), `OpInjectAbortedError`. Both error
  normalizers share the `classifyExecError` core.
- `src/gitRunner.ts` — `GitRunner.getEmail(gitDir, signal?)` runs
  `git -C <gitDir> config --get user.email`. Throws `GitEmailNotFoundError`
  when git is missing or no `user.email` is configured.
- `src/sessionConfig.ts` — Pure shared contract for resolver/tracker session
  metadata. Owns `SECRET_RESOLVER_CONFIG_FIELD` (`"__secretResolver"`),
  `SecretResolverSessionConfig`
  (`{ steps: SignalStep[]; accountId?: string }`), `SignalStep` / `SignalName`
  (`"TERM" | "KILL" | "INT" | "HUP"`), the `SIGNAL_NAMES` set (single source
  for signal-name validation), and the `SessionConfigCodec` class with static
  `build` / `parse`. Keep producer/consumer changes on this module instead of
  duplicating runtime validation in `debugAdapterProxy.ts` or re-exporting the
  contract from `resolveLaunchConfig.ts`.
- `src/resolveLaunchConfig.ts` — `LaunchConfigResolver` plus the module-level
  marker-var constants (`INTERNAL_VAR_PATTERN` `/^SECRET_RESOLVER_/` used to
  strip internal keys, `SIGNAL_ON_STOP_VAR`, `TOKEN_TAG_VAR`,
  `ACCOUNT_EMAIL_VAR`, `ACCOUNT_GIT_CONFIG_VAR`, `ACCOUNT_ID_VAR`) and the
  `EnvFileReader` interface (`parse(path)`, implemented via `DotenvFile` in
  `configProvider.ts`). The constructor takes typed collaborators only:
  `ResolverCache`, `OpRunner`, `EnvFileReader`, `UserNotifier`,
  `AccountResolverFactory`, `TokenResolverFactory`, `WorkspaceTrustReader`
  (interface exported here; `vscode.workspace.isTrusted`-backed in
  `configProvider.ts` — an untrusted workspace aborts any launch with an
  `env`/`envFile` instead of resolving it, matching the
  `untrustedWorkspaces: "limited"` declaration in `package.json`). The
  `op://`-ref check (`isOpRef` + `OP_REF_PATTERN`) and signal-on-stop parsing
  (`parseSignalOnStop` + `DEFAULT_STEP_DELAY_SECONDS`, `STEP_PATTERN`) live on
  the class as `private static` members; `parseSignalOnStop` returns a
  discriminated result (`off` / `invalid` / `steps`) so warning logic does not
  re-parse the raw value. Type-only `vscode` import so unit tests run without
  the extension host. `resolve()` orchestrates `readEnvFile`,
  `resolveLaunchAccount`, `resolveServiceAccountToken`, `resolveFinalEnv`, and
  `buildResolvedDebugConfiguration`; add new launch-planning branches inside
  those steps rather than re-growing the entrypoint. It merges envFile + inline
  env (inline wins), **always** resolves every `op://` ref in-process via
  `OpRunner.inject` (caching plaintext in the `ResolverCache` ref namespace,
  scoped by the launch's resolved account and token tag), strips every
  `SECRET_RESOLVER_*` key, removes any pre-existing `__secretResolver` field
  from the incoming config (the field is resolver-authored output, never
  trusted input), replaces `config.env`, and deletes `config.envFile`. When
  `SECRET_RESOLVER_TOKEN_TAG` is set and the env contains at least one `op://`
  ref, it resolves the service-account token (via `TokenResolverFactory`) and
  passes it to `inject` via `options.token` — in-process only; the token is
  never handed to the tracker. If there are no refs the token lookup is
  skipped. Account-resolution priority: `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` >
  `SECRET_RESOLVER_ACCOUNT_EMAIL` > `SECRET_RESOLVER_ACCOUNT_ID`; the resolved
  `accountId` is forwarded to both the token resolver and `inject`. When signal
  steps are configured or `accountId` is non-null, the
  `SessionConfigCodec.build` result is attached under
  `SECRET_RESOLVER_CONFIG_FIELD` for the tracker to read.
- `src/configProvider.ts` — `SecretDebugConfigurationProvider`, the
  `vscode`-aware entry point
  (`resolveDebugConfigurationWithSubstitutedVariables`). Bridges
  `CancellationToken` → `AbortSignal`, reads `secretResolver.opPath`, and
  builds a `LaunchConfigResolver` via `buildResolver` (wiring `OpRunner`,
  `GitRunner`, `ResolverCache`, `WindowUserNotifier`, the `EnvFileReader`, the
  `vscode.workspace.isTrusted`-backed `WorkspaceTrustReader`, and the
  `AccountResolverFactory` / `TokenResolverFactory` implementations —
  `EmailAccountResolver`, `GitConfigAccountResolver`, `TagTokenResolver`);
  `refreshResolver` rebuilds it when `opPath` changes. Constructed directly
  (`new SecretDebugConfigurationProvider(cache, logger)`) by `extension.ts`.
- `src/debugAdapterProxy.ts` — Per-session tracker and VS Code-facing
  orchestration. Owns the module-private `isRunInTerminalRequest` DAP type
  guard (its only consumer). The factory reads the resolved launch env from
  `session.configuration.env` (`readLaunchEnv`) and hands it to the
  `RunInTerminalEnvRewriter`. On every `runInTerminal` request, delegates
  env-file writing and arg rewriting to `RunInTerminalEnvRewriter`, registers
  returned temp dirs with `TempDirRegistry`, and removes them on
  `onWillStopSession` / `onExit`. When
  `SessionConfigCodec.parse(session.configuration)` returns metadata, delegates
  PID capture and stop-signal handling to `StopSignalController`. The factory's
  `TrackerFactoryOptions` accepts injectable `ProcessController`,
  `ProcessTreeReader`, `Logger`, and `UserNotifier` collaborators (production
  defaults: `NodeProcessController`, `PidtreeProcessTreeReader`,
  `ConsoleLogger` unless the extension passes the output-channel logger,
  `WindowUserNotifier`) so tests can stub all side effects.
- `src/runInTerminalEnvRewriter.ts` — Terminal env rewrite collaborator used by
  `debugAdapterProxy.ts`. Builds the env-file content by merging the launch
  config env (constructor-injected baseline — every launch var moves into the
  file, even ones the adapter did not forward) with the DAP request env
  (adapter entries win on clashes; `null` entries unset the variable), writes
  `env` and `.pid` files (`0600`) inside a `0700` temp dir, rewrites
  `arguments.args` to a single
  `op run --env-file=<file> [--account <id>] -- <orig args>` wrap via
  `OpRunner.buildRunArgs`, clears `arguments.env`, and returns the temp dir for
  the tracker to register. Skips the wrap only when the merged env is empty.
  Takes a `UserNotifier` and `Logger`; on rewrite failure it cleans up its
  just-created dir, logs the error, and shows a user-visible warning that the
  launch proceeds without the `op run` wrapper.
- `src/stopSignalController.ts` — Stop-signal collaborator used by
  `debugAdapterProxy.ts`; no `vscode` import. Exports the `ProcessController`
  interface (`kill` / `setTimer` / `clearTimer`) and its
  `NodeProcessController` default (backed by `process.kill` and global timers).
  The controller takes the session config, a `ProcessController`, a
  `ProcessTreeReader`, a `ProcessFinder`, a `UserNotifier`, and a `Logger`.
  Captures `shellProcessId` (preferred) / `processId` from `runInTerminal`
  responses, tracks DAP `exited` events, and on `disconnect` with
  `terminateDebuggee !== false` iterates the configured `SignalStep[]`: each
  step waits `delaySec` seconds then signals **every process in the captured
  root's tree except the root itself**. When the `runInTerminal` response
  carries no PID (VS Code reports none for external terminals), the controller
  falls back to the launch marker set by the tracker
  (`setLaunchMarker(<temp-dir basename>)`): it locates the `op run` wrapper via
  `ProcessFinder.findProcessIdByCommandLineMarker` and uses that PID as the
  root. A terminal launch that can be pinned neither way gets a user-visible
  warning; launches with no terminal at all (`internalConsole`) stay silent.
  There is no `op`-specific detection — whatever the wrapper is (`op run` or
  otherwise), the whole subtree beneath the root is signaled; the root is left
  alone because it is the runInTerminal shell (or the wrapper itself in the
  marker fallback). The tree is re-walked at each step so processes forked
  between steps are still caught. Only one timer is active at a time; natural
  program exit and tracker `onExit` cancel pending timers. Session stop
  (`onWillStopSession`) intentionally does not cancel. Detach
  (`terminateDebuggee: false`) is a no-op. Routine progress (captured PID and
  sent signals) goes to the `Logger`; a user-visible warning is shown via the
  `UserNotifier` when the root has no descendants to signal.
- `src/processTree.ts` — Process helpers for signal-on-stop. The
  `ProcessTreeReader` interface (`getProcessTree(rootPid)` returning the tree's
  PIDs including the root, breadth-first) and its `PidtreeProcessTreeReader`
  implementation (wraps `pidtree(rootPid, { root: true })`; logs and returns
  `[]` on any error); plus the `ProcessFinder` interface
  (`findProcessIdByCommandLineMarker(marker)`) and its `PgrepProcessFinder`
  implementation (`pgrep -f <marker>`; first PID, warns on multiple matches,
  `null` on no match or failure — pgrep exit 1 is treated as "no match", not an
  error; injectable `pgrepPath` like `GitRunner`). The finder is the
  external-terminal fallback only — the per-launch temp-dir basename is the
  unique marker embedded in the `op run --env-file=...` command line. Signal
  targeting itself remains PID-based; there is no `op`-wrapper detection.
- `src/tempDirRegistry.ts` — Owns the `TempDirRegistry` interface
  (`add`/`remove`) the tracker factory accepts, and `InMemoryTempDirRegistry`
  (`add`/`remove`/`snapshot`/`drain`) with a `cleanup()` instance method
  (synchronous, safe from `process.on('exit'|signals)`), a static
  `removeDirectoryQuietly()` (the shared best-effort recursive removal used by
  the tracker, the rewriter, and the registry itself), and a static
  `sweepStale()` (activation-time scan of `os.tmpdir()` for `secret-resolver-*`
  dirs with dead `.pid` owners).
- `src/extension.ts` — `Extension` class that owns the session state (private
  `SecretCache` + `InMemoryTempDirRegistry`). Its `activate(context)` runs the
  activation-time stale-dir sweep, creates the `Secret Resolver` log output
  channel (wrapped in an `OutputChannelLogger` handed to the provider and the
  tracker factory), and registers the configuration provider for `*`, the
  tracker factory (with the registry and logger) for `*`, the
  `secretResolver.clearCache` command, and a `onDidChangeConfiguration`
  listener that clears the cache when `secretResolver.opPath` changes;
  `dispose()` zeroes the session key and drains the registry;
  `cleanupTempDirs()` drains the registry only. A single module-level
  `extension` handle bridges VS Code's top-level `activate`/`deactivate` hooks
  and the once-installed `process.on('exit'|'SIGTERM'|'SIGINT'|'SIGHUP')`
  cleanup handlers to the live instance (unavoidable: `deactivate()` takes no
  args and signals fire outside `context.subscriptions` disposal).

## Settings

- `secretResolver.opPath` (string, default `"op"`): path to the 1Password CLI
  binary. Unqualified values are looked up on `PATH`. Changing this setting
  clears the resolved-secret cache.

## Commands

- `secretResolver.clearCache` (palette: `Secret Resolver: Clear Cache`): drops
  every cached value and rotates the session key.

## Per-launch env vars

The extension reads these marker env vars from the merged `env`/`envFile` map
and strips every `SECRET_RESOLVER_*` key before the adapter sees them:

- `SECRET_RESOLVER_MODE` — obsolete. No longer read; an explicit value (e.g.
  `"op"`) is silently ignored. Still stripped along with every other
  `SECRET_RESOLVER_*` key. The single resolution path always runs `op inject`
  in-extension, replaces refs with plaintext, caches the resolved values for
  the session, and wraps terminal-mode launches in `op run --env-file` (the
  file holds plaintext, `op run` becomes a pass-through env loader that keeps
  the env off the command line).
- `SECRET_RESOLVER_TOKEN_TAG` — tag identifying the "API Credential" vault item
  whose `credential` field is used as `OP_SERVICE_ACCOUNT_TOKEN` for this
  launch. Resolved once per session per tag and cached. The token is passed to
  `op inject` in-process via its child environment, never via command-line
  arguments and never written to a file or handed to the tracker. Cleared by
  `Secret Resolver: Clear Cache`. Launches with the token tag but no `op://`
  refs skip the lookup.
- `SECRET_RESOLVER_SIGNAL_ON_STOP` — a `+`-separated sequence of signal steps.
  Each step: optional `N:` delay prefix (seconds; default 0 for the first step,
  30 for subsequent steps), then a signal name (`TERM`, `KILL`, `INT`, `HUP`;
  case-insensitive). `"off"` or empty means no signaling (default). When set on
  a terminal launch, the resolver attaches a `__secretResolver: { steps }`
  field to the returned `DebugConfiguration`. The tracker reads it via
  `session.configuration` and dispatches the step sequence on the DAP
  `disconnect` request when `terminateDebuggee !== false`. Detach is a no-op.
  Ignored for `internalConsole`. Unknown / unparsable values warn and produce
  no signaling. The account for a launch is pinned by exactly one of the
  following, checked in this priority order:
  `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` > `SECRET_RESOLVER_ACCOUNT_EMAIL` >
  `SECRET_RESOLVER_ACCOUNT_ID`. The resolved account UUID is passed as
  `--account <id>` to every `op` command (item lookup, `op inject`, and
  `op run`) and attached to `__secretResolver` so the tracker can add
  `--account` to the `op run` wrap.

- `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` — highest priority. Resolves the account
  by reading `user.email` from git config in `<workspacePath>/<subdir>`. Value
  is a relative subdir (`.` = workspace root, empty = off). Runs
  `git -C <workspacePath/subdir> config --get user.email` via `GitRunner` on
  every launch (the email is not cached), then looks up the matching account.
  Only the resolved email → UUID is cached in `SecretCache`.
- `SECRET_RESOLVER_ACCOUNT_EMAIL` — resolves the account from a plain email
  address (e.g. `user@example.com`). Runs `op account list --format json`,
  finds the matching account by email (case-insensitive), and uses its
  `account_uuid`. Email → UUID cached in `SecretCache`.
- `SECRET_RESOLVER_ACCOUNT_ID` — lowest priority. A literal 1Password account
  shorthand or UUID, used verbatim as the `--account` value (via
  `LiteralAccountResolver`). Stripped like every other `SECRET_RESOLVER_*` key.

## Non-goals (v1)

- No Windows support (the factory returns `undefined` on `win32`).
- No support for adapter-specific non-map env shapes (e.g. `cppdbg`'s
  `environment: array`). Such launches do not have a runInTerminal `env` field
  for the tracker to act on; raw `op://` references reach the program
  unchanged.
- No persisted cache. The cache is in-memory only and cleared on extension
  deactivate, on `secretResolver.opPath` config changes, and via the
  `secretResolver.clearCache` command.

## Build and Test

Use the commands documented in `DEVELOPMENT.md`. For substantial changes,
prefer `nx run stage:check` before concluding work.

Assume Node.js 20+ and pnpm 10.33.0/Corepack are the baseline local tools.
Treat `op`, `git`, `gh`, and `xvfb-run` as workflow-specific rather than
general setup requirements. Treat `package.json` as authoritative for extension
name, version, and `engines.vscode`; build, release, and VS Code test configs
derive from it where practical.

For transitive security advisories where the upstream parent package has not
yet released a fix, prefer a minimal `overrides` entry in `pnpm-workspace.yaml`
(pnpm ≥ 10.33 no longer reads the `pnpm` field in `package.json`) and refresh
`pnpm-lock.yaml` rather than adding a direct dependency that does not control
the vulnerable subtree.

The build tool is Vite, orchestrated by Nx via the `build:src` target (the
`build` target is a noop wrapper over it). `build:src` has two configurations:
`production` (default — `vite build`, minified, used for packaging) and
`development` (`vite build --mode development`, not minified, used for the F5
loop and testing). Both configurations emit sourcemaps.
`nx run build:src --configuration=development` produces the dev build;
`nx run build:src` (or `nx run build`) produces the release build. Vite bundles
`src/extension.ts` into `dist/extension.js` (CJS, Node 20 target). Runtime
dependencies (`pidtree`, `@vscode/debugprotocol`) are bundled; `vscode` and
Node built-ins are external (Node built-ins are enumerated via `builtinModules`
from `node:module`). Config lives in `vite.config.ts`.

Unit tests live in `spec/` and are run with Vitest (`nx run test:unit` →
`vitest run spec`). Vitest is configured in `vite.config.ts`
(`test.include: ["spec/**/*.test.ts"]`, `globals: true`); it compiles
TypeScript in-memory via esbuild so no separate build step is needed. The tests
cover the pure modules: `stringEnvMap`, `dotenv`, `secretCache`,
`resolverCache`, `opRunner`, `sessionConfig`, `resolveLaunchConfig`,
`accountResolver`, `tokenResolver`, and `processTree` (`PgrepProcessFinder`
against a fake `pgrep` binary). Whole-tree stop-signal behavior — including the
external-terminal marker fallback — is covered by the integration tests in
`test/`. Each test injects fakes for all I/O (`OpRunner`, filesystem, git, op
CLI) so no real 1Password CLI or filesystem access is required. Integration
tests live in `test/` and are compiled by `tsconfig.test.json`
(`outDir: dist/test`, emitting `src/` and `test/`) so the integration tests
land at `dist/test/test/**/*.test.js` (the glob `.vscode-test.mjs` runs) and
their `../src/…` imports resolve to `dist/test/src/…`. The `test:integration`
target runs `tsc -p tsconfig.test.json` then `vscode-test` (it is **not**
nx-cached — its result depends on the downloaded VS Code install / GUI, which
are not nx inputs, so caching it produces false "flaky" reports). Type-checking
for all source trees (`src/`, `spec/`, `test/`) is handled by the single
`tsconfig.json` via `nx run check:types` → `tsc --noEmit`.
`nx run test:integration` and `nx run test` default to the `development`
configuration so they use a non-minified build.

To test manually: press F5 in VS Code to launch the Extension Development Host,
then start a debug session from `examples/.vscode/launch.json`. The preset
configs exercise the matrix of `node` and `java` across the three console modes
(`integratedTerminal`, `externalTerminal`, `internalConsole`). For terminal
consoles the resolver populates the env file with plaintext and the spawned
terminal shows
`op run --env-file=/<tmp>/secret-resolver-XXXXXX/env -- <orig args>`; `op run`
loads it as a pass-through and the program receives resolved env values. For
`internalConsole` the adapter receives plaintext directly with no temp file.
After the session ends, the temp dir under `os.tmpdir()` should be gone.

## Script Utilities

- `scripts/util.ts` centralizes reusable script helpers: clean-worktree checks,
  `package.json` version writes, targeted file formatting for script-managed
  files, publish preflight loading, GitHub auth detection, VSIX resolution, and
  `runEntrypoint`.
- `writeVersion()` also keeps `package.json` `preview` synchronized with the
  target version: prerelease/`-dev` versions are preview builds, stable
  versions are not.
- `scripts/ship-github.ts` accepts either `GITHUB_TOKEN` or an existing `gh`
  authentication session. It uses `gh release create --verify-tag`, so manual
  GitHub shipping requires the release tag to already exist on the remote.
- `scripts/generate-icon.ts` exports `generateIcon()` and only runs through
  `runEntrypoint`, so it is safe to import without side effects.
- `scripts/changelog.ts` and `scripts/release.ts` must leave formatter-managed
  files formatted when they write `CHANGELOG.md` or `package.json`, and only
  run formatters for files whose contents changed.

## Release Flow

`scripts/release.ts` handles version bumping with a release-branch model
(`nx run release:commit`):

- On `main` with a `*-dev` version: derives the release version directly from
  `package.json` (stripping the `-dev` suffix) and infers the bump label by
  comparing against the highest-versioned release branch (`vX.Y-dev`) and tag
  (`vX.Y.Z`) in the repository. The label is purely informational and does not
  change the resulting version. To release a major bump, set `package.json` to
  `X.0.0-dev` before running release; to release a minor bump, leave it at
  `X.Y.0-dev`. Errors if `package.json` is not strictly ahead of the latest
  release ref. Creates branch `v<major>.<minor>-dev`, commits the release
  version there, creates the release tag, bumps the release branch to the next
  patch `*-dev`, then bumps `main` to the next minor `*-dev`.
- On a release branch with a `*-dev` version: commits the release version,
  creates the release tag, then bumps the branch to the next patch `*-dev`.
- At the release-commit step, `conventional-changelog` regenerates
  `CHANGELOG.md` (conventionalcommits preset) and the updated file is folded
  into the same commit as the version bump. When releasing from `main`, the
  regenerated `CHANGELOG.md` is also copied from the release branch onto `main`
  (via `git checkout <release-branch> -- CHANGELOG.md`) and committed alongside
  the next-dev version bump. Commit messages must follow the
  [Conventional Commits spec](https://www.conventionalcommits.org/en/v1.0.0/)
  for entries to appear.
- All commits authored by `scripts/release.ts` use Conventional Commits format:
  `chore: release X.Y.Z` for releases and `chore: start X.Y.Z-dev development`
  for next-dev bumps. The bump-detection regex in `release.ts` matches both the
  Conventional form and the legacy `Start X.Y.Z-dev development` form for
  backward compatibility.

Tags of the form `vX.Y.Z` (or `vX.Y.Z-rc.N` for pre-releases) trigger
`.github/workflows/ship.yml`, which packages the `.vsix`, publishes to VS Code
Marketplace and Open VSX, and cuts a GitHub release with the `.vsix` attached.

## AI Learnings

- VSIX packaging is controlled by the `files` field in `package.json`, not by
  `.vscodeignore`; both mechanisms achieve the same result. [2026-05-10]
- Test files in `spec/` use intentional non-word strings — suppress cspell on
  those lines with `// cspell:disable-line` rather than adding garbage words to
  `cspell.dict`. [2026-05-10]
- The `tasks.json` intentionally contains only `compile` and `watch` tasks; all
  other build/test/release operations use `nx` targets directly (via terminal
  or `nx run`). [2026-05-10]
- All 1Password CLI access is consolidated in `src/opRunner.ts` (`OpRunner`);
  the earlier `opCli.ts` / `opInject.ts` split was merged here. Error
  normalization lives in the module-private `normalizeCliError` /
  `normalizeInjectError`; account/token resolvers call `OpRunner` methods
  rather than `execFile` directly. [2026-06-26]
- Cache namespace helpers live in `src/resolverCache.ts`; `extension.ts` and
  resolver modules must use those helpers instead of constructing synthetic
  cache keys directly. [2026-05-11]
- The `my:development` rule "MUST use enums for finite sets" is superseded for
  TypeScript files by the `my:development-typescript` rule "MAY use union
  types" — union types are preferred here for simple string finite sets (e.g.
  `SignalName`). [2026-05-11]
