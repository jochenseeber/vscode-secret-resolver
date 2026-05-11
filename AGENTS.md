# Agent Instructions

- MUST read `README.md` for project description and usage instructions.
- MUST add information for humans to `README.md`
- MUST add information for AI agents to `AGENTS.md`
- MUST keep both files non-redundant

## Project Overview

This is a VS Code extension (`vscode-secret-resolver`) that resolves 1Password
`op://` secret references in debug-launch environment variables. The per-launch
knob `SECRET_RESOLVER_MODE` selects between two paths. The default is
`"cache"`.

- `SECRET_RESOLVER_MODE="op"` — resolver leaves `op://` refs in `config.env`.
  For terminal consoles the tracker writes the env to a temp dotenv file under
  `os.tmpdir()` and rewrites `runInTerminal.args` to
  `op run --env-file=<tempfile> -- <orig args>`, so the 1Password CLI resolves
  the refs at exec time. Combining `"op"` with `console: "internalConsole"`
  aborts the launch with an error (`op run` needs a terminal-style spawn).
- `SECRET_RESOLVER_MODE="cache"` — resolver runs `op inject` in-extension and
  caches the resolved plaintext obfuscated in memory for the duration of the VS
  Code session. The tracker still wraps the launch in `op run --env-file` for
  terminal consoles (the env file holds plaintext, `op run` becomes a
  pass-through env loader). For `internalConsole` no terminal is involved, no
  temp file is written; the adapter receives plaintext directly via
  `config.env`.

For terminal consoles, the env never flows through DAP `arguments.env`
plaintext — it lives only in the temp file (mode `0600`) inside an `0700` temp
dir, and is removed on session end. Crashed-session leftovers are swept on next
activation by checking the dir's `.pid` file against live PIDs.

## Architecture

- `src/envHelpers.ts` — Pure helpers, no `vscode` import. `OP_REF_PATTERN`,
  `findOpRefs`, `hasOpRef`, `replaceOpRefs`, `stripInternalEnvVars` (regex
  `/^SECRET_RESOLVER_/`), `parseSecretResolverMode` (returns `"op" | "cache"`),
  `parseSignalOnStop` (returns `SignalStep[] | null`, where `SignalStep` is
  `{ delaySec: number; signal: SignalName }` and `SignalName` is
  `"TERM" | "KILL" | "INT" | "HUP"`; `null` means off),
  `DEFAULT_STEP_DELAY_SECONDS` (30), `mergeEnv`, `MODE_VAR`
  (`"SECRET_RESOLVER_MODE"` — automatically stripped), `SIGNAL_ON_STOP_VAR`
  (`"SECRET_RESOLVER_SIGNAL_ON_STOP"` — automatically stripped),
  `TOKEN_TAG_VAR` (`"SECRET_RESOLVER_TOKEN_TAG"` — automatically stripped by
  `stripInternalEnvVars` alongside other `SECRET_RESOLVER_*` keys),
  `ACCOUNT_ID_VAR` (`"SECRET_RESOLVER_ACCOUNT_ID"` — automatically stripped),
  `ACCOUNT_EMAIL_VAR` (`"SECRET_RESOLVER_ACCOUNT_EMAIL"` — automatically
  stripped), `ACCOUNT_GIT_CONFIG_VAR` (`"SECRET_RESOLVER_ACCOUNT_GIT_CONFIG"` —
  automatically stripped). `parseSecretResolverMode` and `parseSignalOnStop`
  accept an optional warning reporter; default is `console.warn`, while
  `resolveLaunchConfig` injects `deps.showWarning`.
- `src/launchRewrite.ts` — Pure helpers: `isRunInTerminalRequest` (DAP type
  guard) and
  `buildOpRunArgs(opPath, envFilePath, args, account?) →
  [opPath, "run", ..."--account" + account if set, "--env-file=" + envFilePath, "--", ...args]`.
- `src/dotenv.ts` — Minimal dotenv parser used for `envFile` resolution. Throws
  `EnvFileNotFoundError` for ENOENT so callers can warn and continue. Also
  exports `formatDotenv(env)` — writer used by the tracker to produce files
  `op run --env-file` accepts. Safe ASCII values are written unquoted;
  everything else is double-quoted with backslash escapes for `\`, `"`, `$`,
  `\n`, `\r`.
- `src/secretCache.ts` — `SecretCache` class. Session-scoped 32-byte key in a
  closure-scoped `Buffer`, HMAC-SHA256 cache keys, AES-256-GCM encrypted values
  with per-entry IV. `clear()` zeroes the key buffer in place and rotates.
  Obfuscation, not real encryption — the goal is to defeat heap dumps and
  accidental log disclosure.
- `src/resolverCache.ts` — Domain cache namespace helpers layered over
  `SecretCache`: resolved refs (`getCachedResolvedRef` /
  `setCachedResolvedRef`), service account tokens (`getCachedToken` /
  `setCachedToken`), and account IDs (`getCachedAccountId` /
  `setCachedAccountId`). Keep synthetic key naming here; callers should not
  construct cache keys directly.
- `src/accountResolver.ts` — Pure async helper; no `vscode` import.
  `GitEmailStore` interface (`get/set/clear`) — injected by
  `configProvider.ts`, backed by `workspaceState`.
  `resolveAccountForEmail(email, opPath, cache, signal?)` — resolves a
  1Password `account_uuid` from a plain email address by using `OpCli` to run
  `op account list --format json`. Caches result via `resolverCache`'s account
  namespace.
  `resolveAccountForGitConfig(subdir, opPath, cache, signal?, workspacePath?,
  gitEmailStore?)`
  — resolves account UUID by reading `user.email` from
  `git -C <workspacePath/subdir/.git> config --get user.email`, then looking up
  the matching account. `subdir` must be relative; `.` means workspace root.
  Two-layer cache: layer 1 is `gitEmailStore` (`.git`-dir path → email,
  best-effort persistence); layer 2 is `SecretCache` via `resolverCache` (email
  → uuid). Error classes: `AccountNotFoundError` (no matching account),
  `GitEmailNotFoundError` (git not installed or no user.email configured).
- `src/tokenResolver.ts` — Pure async helper; no `vscode` import.
  `resolveTokenForTag(tag, opPath, cache, signal?, account?)` — resolves the
  service account token for `tag` via two `OpCli` JSON calls (both include
  `--account <account>` when set via `OpCli`):
  1. `op item list --tags <tag> --categories "API Credential" --format json`
  2. `op item get <id> --vault <vaultId> --fields label=credential --format json`
     Caches the result in `SecretCache` via `resolverCache`'s token namespace.
     Error classes: `TokenNotFoundError` (empty item list),
     `TokenCredentialMissingError` (missing `credential` field). ENOENT and
     non-zero exit are normalized to the same `OpCliNotFoundError` /
     `OpInjectError` classes from `opInject.ts`.
- `src/opCli.ts` — `OpCli` helper for non-`inject` 1Password CLI calls.
  `execText(args, options)` and `execJson<T>(args, options)` centralize
  `child_process.execFile`, `normalizeOpCliError`, abort propagation,
  `--account <id>` insertion for item commands, optional removal of inherited
  `OP_SERVICE_ACCOUNT_TOKEN`, and JSON parse errors. Use this for account/item
  lookup commands instead of duplicating process setup in resolver modules.
- `src/opInject.ts` — `OpInjectRunner` interface + `DefaultOpInjectRunner`.
  Spawns `<opPath> inject` via `child_process.spawn`, feeds a sentinel-wrapped
  (`__SR_<uuid>_BEGIN_<n>__` / `__SR_<uuid>_END_<n>__`) template on stdin,
  parses stdout. Distinct error classes: `OpCliNotFoundError`, `OpInjectError`,
  `OpInjectAbortedError`. `resolve()` accepts an optional `token?: string` (4th
  arg) and `account?: string` (5th arg); `token` is passed as
  `OP_SERVICE_ACCOUNT_TOKEN=<token>` in the child env; `account` is passed as
  `--account <account>` in the CLI args.
- `src/sessionConfig.ts` — Pure shared contract for resolver/tracker session
  metadata. Owns `SECRET_RESOLVER_CONFIG_FIELD` (`"__secretResolver"`),
  `SecretResolverSessionConfig`
  (`{ steps: SignalStep[]; tokenTag?: string;
  accountId?: string }`),
  `buildSessionConfig`, and `parseSessionConfig`. Keep producer/consumer
  changes on this module instead of duplicating runtime validation in
  `debugAdapterProxy.ts` or re-exporting the contract from
  `resolveLaunchConfig.ts`.
- `src/resolveLaunchConfig.ts` — Pure async resolver. Type-only `vscode` import
  (so unit tests can run without the extension host). Implements the decision
  tree: skip non-map env shapes, parse envFile, merge file+inline with inline
  winning, read `SECRET_RESOLVER_MODE` (default: `"cache"`), strip every
  `SECRET_RESOLVER_*` key, branch to op-run/cache path, replace `config.env`,
  delete `config.envFile`. Keep the top-level `resolveLaunchConfig` entrypoint
  as orchestration around `readLaunchEnv`, `parseLaunchOptions`,
  `resolveLaunchAccount`, `resolveLaunchToken`, `resolveFinalEnv`, and
  `buildResolvedDebugConfiguration`; add new launch-planning branches inside
  those steps instead of re-growing the entrypoint. When
  `SECRET_RESOLVER_TOKEN_TAG` is present and the stripped env contains at least
  one `op://` ref, calls `deps.resolveTokenForTag` (injectable; wired via
  `configProvider.ts`) to resolve the service account token, then passes it as
  the 4th arg to `runner.resolve` for cache-mode. If there are no refs, token
  lookup is skipped and no token metadata is attached to the terminal session.
  Account resolution priority: `ACCOUNT_ID_VAR` > `ACCOUNT_EMAIL_VAR` (plain
  email address, calls `deps.resolveAccountForEmail`) >
  `ACCOUNT_GIT_CONFIG_VAR` (relative git subdir, `.` = workspace root, empty =
  off, calls `deps.resolveAccountForGitConfig`). When
  `SECRET_RESOLVER_SIGNAL_ON_STOP` is set on a terminal launch,
  `SECRET_RESOLVER_TOKEN_TAG` is set on an op-mode terminal launch, or
  `accountId` is non-null on any terminal launch, attaches the
  `buildSessionConfig` result under `SECRET_RESOLVER_CONFIG_FIELD` for the
  tracker to read. `accountId` is forwarded as the 4th arg to
  `deps.resolveTokenForTag` and the 5th arg to `runner.resolve`.
- `src/configProvider.ts` — `SecretDebugConfigurationProvider` — `vscode`-aware
  wrapper that bridges `CancellationToken` → `AbortSignal`, reads
  `secretResolver.opPath` from configuration, and routes user messages through
  `vscode.window`. Calls into `resolveLaunchConfig`. Owns
  `WorkspaceStateGitEmailStore` (implements `GitEmailStore` via
  `context.workspaceState`, key `"secretResolver.gitEmails"`; `set`/`clear` are
  explicitly best-effort and log rejected updates). Exports
  `createDefaultProvider(cache, gitEmailStore)` and `createGitEmailStore(ws)`.
- `src/debugAdapterProxy.ts` — Per-session tracker and VS Code-facing
  orchestration. On every `runInTerminal` request whose env has at least one
  non-null entry, delegates env-file writing and arg rewriting to
  `RunInTerminalEnvRewriter`, registers returned temp dirs with
  `TempDirRegistry`, and removes them on `onWillStopSession` / `onExit`.
  Defines the `TempDirRegistry` interface the factory accepts; the extension
  owns the implementation. When `parseSessionConfig(session.configuration)`
  returns metadata, delegates PID capture and stop-signal handling to
  `StopSignalController`. The factory accepts an injectable `KillFn`, timer
  hooks, process-tree reader, and `getServiceAccountToken` callback so unit
  tests can stub all side effects.
- `src/runInTerminalEnvRewriter.ts` — Terminal env rewrite collaborator used by
  `debugAdapterProxy.ts`. Converts DAP env maps to string env, writes env and
  `.pid` files (`0600`) inside a `0700` temp dir, optionally writes
  `token.env`, composes single or double `op run --env-file` wraps with
  `buildOpRunArgs`, clears `arguments.env`, and returns the temp dir for the
  tracker to register. Cleans up its just-created dir on rewrite failure.
- `src/stopSignalController.ts` — Stop-signal collaborator used by
  `debugAdapterProxy.ts`. Captures `shellProcessId` (preferred) / `processId`
  from `runInTerminal` responses, tracks DAP `exited` events, and on
  `disconnect` with `terminateDebuggee !== false` iterates the configured
  `SignalStep[]`: each step waits `delaySec` seconds then signals the direct
  children of the `op run` wrapper via `kill(pid, sig)`. Only one timer is
  active at a time; natural program exit and tracker `onExit` cancel pending
  timers. Session stop (`onWillStopSession`) intentionally does not cancel.
  Detach (`terminateDebuggee: false`) is a no-op. Routine progress (captured
  PID and sent signals) goes to `console.info`; user-visible warnings are kept
  for cases where no signal target can be found.
- `src/processTree.ts` — Process-tree helpers for signal-on-stop. `ProcessInfo`
  (`pid`, `ppid`, `command`), `GetProcessTreeFn` interface,
  `defaultGetProcessTree` (uses `pidtree` with `{ root: true, advanced: true }`
  and resolves commands via `/proc/<pid>/cmdline` on Linux or a single `ps`
  call on macOS/BSD; returns `[]` on any error), `isOpRunCommand` (detects an
  `op run` invocation by basename of argv0 + argv1). Consumed by
  `debugAdapterProxy.ts` to locate the `op run` wrapper in the process tree and
  identify its direct children.
- `src/tempDirRegistry.ts` — `InMemoryTempDirRegistry`, `cleanupRegistry`
  (synchronous, safe from `process.on('exit'|signals)`), and
  `sweepStaleTempDirs` (activation-time scan of `os.tmpdir()` for
  `secret-resolver-*` dirs with dead `.pid` owners).
- `src/extension.ts` — Constructs a shared `SecretCache`, a shared
  `InMemoryTempDirRegistry`, and a `GitEmailStore` (via `createGitEmailStore`).
  Clears the `GitEmailStore` on activate (stale entries), deactivate, the
  `secretResolver.clearCache` command, and `secretResolver.opPath` changes.
  Runs the activation-time stale-dir sweep, installs
  `process.on('exit'|'SIGTERM'|'SIGINT'|'SIGHUP')` handlers that drain the
  registry, registers the configuration provider for `*`, the tracker factory
  (with the registry) for `*`, the `secretResolver.clearCache` command, and a
  `onDidChangeConfiguration` listener that clears the cache when
  `secretResolver.opPath` changes. `deactivate()` zeroes the session key,
  clears the git email store, and drains the registry.

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

- `SECRET_RESOLVER_MODE` — controls the resolution path. Values are
  case-insensitive after trimming.
  - `"op"`: resolver leaves `op://` refs in env. Tracker writes the env to a
    temp dotenv file and rewrites `runInTerminal.args` to
    `op run --env-file=<file> -- <orig args>`. `console: "internalConsole"`
    aborts the launch with an error since `op run` needs a terminal-style
    spawn.
  - `"cache"`: resolver runs `op inject` in-extension and replaces refs with
    plaintext, caching the resolved values for the session. Tracker still wraps
    terminal-mode launches in `op run --env-file` (the file holds plaintext,
    `op run` becomes a pass-through env loader).
  - Unset / empty: defaults to `"cache"`.
  - Unknown non-empty values emit a `console.warn` and fall through to
    `"cache"`.
- `SECRET_RESOLVER_TOKEN_TAG` — tag identifying the "API Credential" vault item
  whose `credential` field is used as `OP_SERVICE_ACCOUNT_TOKEN` for this
  launch. Resolved once per session per tag and cached. The token is passed to
  `op` via environment variable, never via command-line arguments. Cleared by
  `Secret Resolver: Clear Cache`. For op-mode terminal launches the tracker
  writes the token to a `token.env` file (same `0600`/`0700` temp dir as `env`)
  and composes a double `op run` wrap; for cache-mode / `internalConsole` it is
  passed to `op inject` in-process. The `tokenTag` string is attached to
  `__secretResolver` only for op-mode terminal launches.
- `SECRET_RESOLVER_SIGNAL_ON_STOP` — a `+`-separated sequence of signal steps.
  Each step: optional `N:` delay prefix (seconds; default 0 for the first step,
  30 for subsequent steps), then a signal name (`TERM`, `KILL`, `INT`, `HUP`;
  case-insensitive). `"off"` or empty means no signaling (default). When set on
  a terminal launch, the resolver attaches a `__secretResolver: { steps }`
  field to the returned `DebugConfiguration`. The tracker reads it via
  `session.configuration` and dispatches the step sequence on the DAP
  `disconnect` request when `terminateDebuggee !== false`. Detach is a no-op.
  Ignored for `internalConsole`. Unknown / unparsable values warn and produce
  no signaling.
- `SECRET_RESOLVER_ACCOUNT_ID` — 1Password account shorthand or UUID. When set,
  passed as `--account <id>` to every `op` command the extension invokes for
  this launch (item lookup, `op inject`, and `op run`). Useful in multi-account
  setups. Attached to `__secretResolver` for terminal launches so the tracker
  can add `--account` to `op run` args. Not included for `internalConsole` (the
  account is forwarded directly to `runner.resolve` in-process).
- `SECRET_RESOLVER_ACCOUNT_EMAIL` — resolves the 1Password account from a plain
  email address (e.g. `user@example.com`). Runs
  `op account list --format json`, finds the matching account by email
  (case-insensitive), and uses `account_uuid` as the `--account` value — same
  effect as `SECRET_RESOLVER_ACCOUNT_ID` once resolved. Ignored when
  `SECRET_RESOLVER_ACCOUNT_ID` is also set. Email → UUID cached in
  `SecretCache`.
- `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` — resolves the 1Password account by
  reading `user.email` from git config at `<workspacePath>/<subdir>/.git`.
  Value is a relative subdir (`.` = workspace root, empty = off). Runs
  `git -C <workspacePath/subdir/.git> config --get user.email`, then looks up
  the account as above. Ignored when `SECRET_RESOLVER_ACCOUNT_ID` or
  `SECRET_RESOLVER_ACCOUNT_EMAIL` is also set (lower priority). `.git`-dir →
  email mapping cached in `workspaceState`; email → UUID cached in
  `SecretCache`. Absolute subdir values abort the launch with an error.

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
yet released a fix, prefer a minimal root `package.json` `pnpm.overrides` entry
and refresh `pnpm-lock.yaml` rather than adding a direct dependency that does
not control the vulnerable subtree.

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
cover the pure modules: `envHelpers`, `dotenv`, `launchRewrite`, `secretCache`,
`opInject`, `resolveLaunchConfig`, `accountResolver`, and `tokenResolver`. Each
test injects fakes for all I/O (OpInjectRunner, filesystem, git, op CLI) so no
real 1Password CLI or filesystem access is required. Integration tests live in
`test/` and require a `tsc` compilation step to produce JS files in
`dist/test/test/` (the path `.vscode-test.mjs` looks for). Type-checking for
all source trees (`src/`, `spec/`, `test/`) is handled by the single
`tsconfig.json` via `nx run check:types` → `tsc --noEmit`.
`nx run test:integration` and `nx run test` default to the `development`
configuration so they use a non-minified build.

To test manually: press F5 in VS Code to launch the Extension Development Host,
then start a debug session from `examples/.vscode/launch.json`. The preset
configs exercise the matrix of `node` and `java` across the three console modes
(`integratedTerminal`, `externalTerminal`, `internalConsole`). Terminal-mode
configs default to `SECRET_RESOLVER_MODE="op"`; the spawned terminal shows
`op run --env-file=/<tmp>/secret-resolver-XXXXXX/env -- <orig args>` and the
program receives resolved env values. The two `(cache mode)` example configs
set `SECRET_RESOLVER_MODE="cache"` so the resolver populates the file with
plaintext; `op run` then loads it as a pass-through. After the session ends,
the temp dir under `os.tmpdir()` should be gone.

## Script Utilities

- `scripts/util.ts` centralizes reusable script helpers: clean-worktree checks,
  `package.json` version writes, targeted file formatting for script-managed
  files, publish preflight loading, GitHub auth detection, VSIX resolution, and
  `runEntrypoint`.
- `writeVersion()` also keeps `package.json` `preview` synchronized with the
  target version: prerelease/`-dev` versions are preview builds, stable
  versions are not.
- `scripts/ship-github.ts` accepts either `GH_TOKEN` or an existing `gh`
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
- Shared error-normalization logic lives in `normalizeOpCliError` (exported
  from `src/opInject.ts`); `OpCli` imports it and account/token resolvers call
  `OpCli` instead of using `execFile` directly. The internal `normalizeError`
  in `opInject.ts` is separate (wraps AbortError in `OpInjectAbortedError` with
  "op inject failed:" prefix) and stays private. [2026-05-11]
- Cache namespace helpers live in `src/resolverCache.ts`; `extension.ts` and
  resolver modules must use those helpers instead of constructing synthetic
  cache keys directly. [2026-05-11]
- The `my:development` rule "MUST use enums for finite sets" is superseded for
  TypeScript files by the `my:development-typescript` rule "MAY use union
  types" — union types are preferred here for simple string finite sets (e.g.
  `SignalName`, `SecretResolverMode`). [2026-05-11]
