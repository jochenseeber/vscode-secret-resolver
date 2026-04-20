# Agent Instructions

- MUST read `README.md` for project description and usage instructions.
- MUST add information for humans to `README.md`
- MUST add information for AI agents to `AGENTS.md`
- MUST keep both files non-redundant

## Project Overview

This is a VS Code extension (`vscode-secret-resolver`) that routes debug
launches through `op run` so 1Password secret references in debug configuration
environment variables are resolved by the 1Password CLI at process start time.
Plaintext secrets never materialize in the extension.

## Architecture

- `src/launchRewrite.ts` — Pure helpers, no `vscode` import. Exports
  `isRunInTerminalRequest` (DAP message type guard) and
  `prependOpRun(args, opPath)` (returns a new args array with
  `[opPath, "run", "--"]` prepended). Unit-testable in isolation.
- `src/debugAdapterProxy.ts` — `SecretDebugAdapterTrackerFactory` registered
  for `*`. On outbound `runInTerminal` DAP requests, the tracker reads the
  `secretResolver.opPath` setting (default `"op"`) and replaces the args via
  `prependOpRun`. The `env` field is left untouched; VS Code sets it on the
  spawned shell so `op run` inherits `op://` references and resolves them
  before `exec`'ing the real command. Relies on tracker messages being passed
  by reference and dispatched after trackers return — documented
  observation-only but practically mutable; see the comment in the source.
- `src/extension.ts` — Extension entry point. Registers the adapter tracker
  factory. That's it.

## Settings

- `secretResolver.opPath` (string, default `"op"`): path to the 1Password CLI
  binary. Unqualified values are looked up on `PATH`.

## Non-goals

- No Windows support (the factory returns `undefined` on `win32`).
- No debug-configuration provider. `envFile` support depends on each debug
  adapter merging `envFile` into its `runInTerminal` env field — which all
  mainstream adapters do.

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

Unit tests live in `test/unit/` and cover the pure helpers in
`src/launchRewrite.ts`. Integration tests live in `test/integration/`; the
`.vscode-test.mjs` config pins the VS Code version to match `engines.vscode` in
`package.json`.

To test manually: press F5 in VS Code to launch the Extension Development Host,
then start a debug session with `op://` references in `env` and/or `envFile`
and `console: "integratedTerminal"`.

## Script Utilities

- `scripts/util.ts` centralizes reusable script helpers: clean-worktree checks,
  `package.json` version writes, targeted file formatting for script-managed
  files, publish preflight loading, GitHub auth detection, VSIX resolution, and
  `runEntrypoint`.
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
