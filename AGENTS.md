# Agent Instructions

- MUST read `README.md` for project description and usage instructions.
- MUST add information for humans to `README.md`
- MUST add information for AI agents to `AGENTS.md`
- MUST keep both files non-redundant

## Project Overview

This is a VS Code extension (`vscode-secret-resolver`) that resolves 1Password
`op://` secret references in debug-launch environment variables. The per-launch
knob `SECRET_RESOLVER_MODE` selects between two paths. The default is
console-aware: `"cache"` for `console: "internalConsole"`, `"op"` for every
other console (including unset).

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
  `mergeEnv`.
- `src/launchRewrite.ts` — Pure helpers: `isRunInTerminalRequest` (DAP type
  guard) and
  `buildOpRunArgs(opPath, envFilePath, args) →
  [opPath, "run", "--env-file=" + envFilePath, "--", ...args]`.
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
- `src/opInject.ts` — `OpInjectRunner` interface + `DefaultOpInjectRunner`.
  Spawns `<opPath> inject` via `child_process.spawn`, feeds a sentinel-wrapped
  (`__SR_<uuid>_BEGIN_<n>__` / `__SR_<uuid>_END_<n>__`) template on stdin,
  parses stdout. Distinct error classes: `OpCliNotFoundError`, `OpInjectError`,
  `OpInjectAbortedError`.
- `src/resolveLaunchConfig.ts` — Pure async resolver. Type-only `vscode` import
  (so unit tests can run without the extension host). Implements the decision
  tree: skip non-map env shapes, parse envFile, merge file+inline with inline
  winning, read `SECRET_RESOLVER_MODE` (console-aware default: `"cache"` for
  `internalConsole`, `"op"` otherwise), strip every `SECRET_RESOLVER_*` key,
  branch to op-run/cache path, replace `config.env`, delete `config.envFile`.
- `src/configProvider.ts` — `SecretDebugConfigurationProvider` — `vscode`-aware
  wrapper that bridges `CancellationToken` → `AbortSignal`, reads
  `secretResolver.opPath` from configuration, and routes user messages through
  `vscode.window`. Calls into `resolveLaunchConfig`.
- `src/debugAdapterProxy.ts` — Per-session tracker. On every `runInTerminal`
  request whose env has at least one non-null entry, the tracker writes the env
  to a `0600` dotenv file inside a `0700` `mkdtemp` dir under `os.tmpdir()`,
  drops a `.pid` file alongside (used by the activation sweep), rewrites
  `arguments.args` via `buildOpRunArgs`, and clears `arguments.env`. Cleanup
  runs on `onWillStopSession` and `onExit`. Also defines the `TempDirRegistry`
  interface the factory accepts; the extension owns the implementation.
- `src/tempDirRegistry.ts` — `InMemoryTempDirRegistry`, `cleanupRegistry`
  (synchronous, safe from `process.on('exit'|signals)`), and
  `sweepStaleTempDirs` (activation-time scan of `os.tmpdir()` for
  `secret-resolver-*` dirs with dead `.pid` owners).
- `src/extension.ts` — Constructs a shared `SecretCache` and a shared
  `InMemoryTempDirRegistry`. Runs the activation-time stale-dir sweep, installs
  `process.on('exit'|'SIGTERM'|'SIGINT'|'SIGHUP')` handlers that drain the
  registry, registers the configuration provider for `*`, the tracker factory
  (with the registry) for `*`, the `secretResolver.clearCache` command, and a
  `onDidChangeConfiguration` listener that clears the cache when
  `secretResolver.opPath` changes. `deactivate()` zeroes the session key and
  drains the registry.

## Settings

- `secretResolver.opPath` (string, default `"op"`): path to the 1Password CLI
  binary. Unqualified values are looked up on `PATH`. Changing this setting
  clears the resolved-secret cache.

## Commands

- `secretResolver.clearCache` (palette: `Secret Resolver: Clear Cache`): drops
  every cached value and rotates the session key.

## Per-launch env vars

The extension reads two kinds of marker env vars from the merged
`env`/`envFile` map and strips every `SECRET_RESOLVER_*` key before the adapter
sees them:

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
  - Unset / empty: console-aware default — `"cache"` for
    `console: "internalConsole"`, `"op"` for every other console.
  - Unknown non-empty values emit a `console.warn` and fall through to the same
    console-aware default.

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

Use the commands documented in `README.md`. For substantial changes, prefer
`pnpm run verify` before concluding work.

Assume Node.js 20+ and pnpm 10.33.0/Corepack are the baseline local tools.
Treat `op`, `git`, `gh`, and `xvfb-run` as workflow-specific rather than
general setup requirements. Treat `package.json` as authoritative for extension
name, version, and `engines.vscode`; build, release, and VS Code test configs
derive from it where practical.

For transitive security advisories where the upstream parent package has not
yet released a fix, prefer a minimal root `package.json` `pnpm.overrides` entry
and refresh `pnpm-lock.yaml` rather than adding a direct dependency that does
not control the vulnerable subtree.

Unit tests live in `test/unit/` and cover the pure modules: `envHelpers`,
`dotenv`, `launchRewrite`, `secretCache`, `opInject`, and
`resolveLaunchConfig`. The resolver's unit test injects a fake `OpInjectRunner`
and a fake `parseEnvFile` to exercise every branch of the decision tree without
touching the real 1Password CLI or filesystem. Integration tests live in
`test/integration/`; the `.vscode-test.mjs` config pins the VS Code version to
match `engines.vscode` in `package.json`.

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

`scripts/release.ts` handles version bumping with a release-branch model:

- On `main` with a `*-dev` version: auto-detects `major` vs `minor` from
  conventional-commit breaking markers since the last "Start X.Y.0 dev" commit.
  Creates branch `v<major>.<minor>-dev`, commits the release version there,
  creates the release tag, bumps the release branch to the next patch `*-dev`,
  then bumps `main` to the next `*-dev`.
- On a release branch with a `*-dev` version: commits the release version,
  creates the release tag, then bumps the branch to the next patch `*-dev`.
- At the release-commit step, `conventional-changelog` regenerates
  `CHANGELOG.md` (conventionalcommits preset) and the updated file is folded
  into the same commit as the version bump. Commit messages must follow the
  [Conventional Commits spec](https://www.conventionalcommits.org/en/v1.0.0/)
  for entries to appear.

Tags of the form `vX.Y.Z` (or `vX.Y.Z-rc.N` for pre-releases) trigger
`.github/workflows/ship.yml`, which packages the `.vsix`, publishes to VS Code
Marketplace and Open VSX, and cuts a GitHub release with the `.vsix` attached.
