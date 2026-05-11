# Source Architecture Review

Review date: 2026-05-11

This review covers the code under `src/`. The current architecture is already
in a good place: the VS Code-facing surface is small, most behavior is isolated
behind pure helpers, and the risky tracker behavior is explicitly documented
and well covered by tests. The suggestions below are therefore mostly about
keeping the project easy to change as more launch-time features are added.

## Highest-value improvements

### 1. Split launch resolution into smaller planning steps (implemented)

`src/resolveLaunchConfig.ts` now owns envFile loading, merged-env validation,
mode selection, account selection, token selection, `op://` resolution,
session-config attachment, and user-facing error mapping. Each individual block
is clear, but the function has become the project's main decision tree.

Status: implemented on 2026-05-11. `resolveLaunchConfig` now delegates to
focused internal steps: `readLaunchEnv`, `parseLaunchOptions`,
`resolveLaunchAccount`, `resolveLaunchToken`, `resolveFinalEnv`, and
`buildResolvedDebugConfiguration`.

The resulting shape is:

- `readLaunchEnv(config, deps)` -> `{ mergedEnv, strippedEnv }` or an
  unchanged/abort result
- `parseLaunchOptions(mergedEnv, consoleKind)` -> mode, signal steps, token
  tag, account selector, terminal/op-run decisions
- `resolveLaunchAccount(options, deps, signal)` -> `accountId | null`
- `resolveLaunchToken(options, accountId, deps, signal)` -> current token
  resolution behavior, kept separate from account resolution
- `buildResolvedDebugConfiguration(...)` -> final env plus optional session
  metadata

This makes the launch behavior easier to test as a matrix and makes new
per-launch knobs less likely to add another nested branch to one large
function. The separate token-resolution optimization in item 5 remains open.

### 2. Make the session config contract a first-class module (implemented)

Status: implemented on 2026-05-11. `src/sessionConfig.ts` now owns
`SECRET_RESOLVER_CONFIG_FIELD`, `SecretResolverSessionConfig`,
`buildSessionConfig`, and `parseSessionConfig`.

The resulting shape is:

- `resolveLaunchConfig` builds optional terminal-session metadata with
  `buildSessionConfig`.
- `debugAdapterProxy` reads and validates the metadata with
  `parseSessionConfig`.
- Tests import the field/type from `sessionConfig` rather than from the launch
  resolver.

This reduces the chance that `resolveLaunchConfig` and `debugAdapterProxy`
drift when new metadata is added.

### 3. Decompose the debug adapter tracker (implemented)

`src/debugAdapterProxy.ts` is doing three jobs in one class:

- rewriting `runInTerminal` requests into `op run --env-file` launches
- creating, registering, and cleaning temp env files
- capturing PIDs and dispatching stop-signal sequences

The behavior is cohesive from VS Code's point of view, but the implementation
would be easier to reason about if the tracker became orchestration around two
small collaborators:

- `RunInTerminalEnvRewriter`: accepts args/env/session config/opPath and
  returns rewritten args plus temp dirs to register
- `StopSignalController`: accepts DAP messages, tracks the selected PID, and
  dispatches configured signal steps

The synchronous filesystem calls in the DAP hook are probably the right
tradeoff because the message must be mutated before VS Code forwards it. Moving
that work into a helper would make this constraint explicit and keep the
tracker focused on message routing.

Status: implemented on 2026-05-11. `debugAdapterProxy` now keeps the VS Code
tracker/factory wiring and delegates the two larger responsibilities:

- `src/runInTerminalEnvRewriter.ts` owns terminal env serialization, temp-file
  creation, token env-file creation, `op run` arg wrapping, and clearing
  `arguments.env`.
- `src/stopSignalController.ts` owns PID capture, exited/disconnect message
  handling, timer sequencing, process-tree lookup, and signal dispatch.

The tracker still owns temp-dir registration and session cleanup so extension
activation/deactivation behavior stays centralized.

### 4. Add an `OpCli` abstraction for non-inject commands (implemented)

`src/accountResolver.ts` and `src/tokenResolver.ts` both use `execFile`
directly, parse JSON, normalize CLI failures, and remove
`OP_SERVICE_ACCOUNT_TOKEN` where needed. `normalizeOpCliError` already improved
the duplication, but there is still a repeated pattern around JSON CLI calls.

Suggested shape:

- Add a small `OpCli` helper with `execJson<T>(args, options)` and
  `execText(args, options)`.
- Keep account and token modules focused on 1Password domain decisions.
- Centralize `--account`, child environment preparation, abort handling, and
  JSON parse errors.

This would also make future `op` calls easier to unit test without adding new
fake shell scripts for each command shape.

Status: implemented on 2026-05-11. `src/opCli.ts` now exposes `OpCli` with
`execText` and `execJson<T>`. It centralizes `--account` insertion, optional
removal of inherited `OP_SERVICE_ACCOUNT_TOKEN`, child-process error
normalization, abort propagation, and JSON parse errors. `accountResolver` and
`tokenResolver` now focus on account/token domain validation rather than direct
`execFile` plumbing.

## Medium-value improvements

### 5. Avoid resolving service-account tokens when no later operation needs one (implemented)

`resolveLaunchConfig` resolves `SECRET_RESOLVER_TOKEN_TAG` whenever it is set
and a resolver is available. In cache mode, that can fetch a token even when
the stripped env contains no `op://` refs, so no `op inject` call will happen.
In terminal op mode, token resolution is needed only when the final terminal
wrap will contain refs that `op run` must resolve.

Suggested rule: compute `hasOpRef(stripped)` before token resolution and fetch
a token only when a later `op inject` or `op run` needs it. Keep an explicit
test for the no-ref case so this remains an intentional optimization rather
than an accidental behavior change.

Status: implemented on 2026-05-11. Launch option parsing now computes
`hasOpRefs` from the stripped env map. `resolveLaunchToken` returns early when
there are no refs to resolve, and terminal session metadata omits `tokenTag` in
that case so the tracker does not attempt a token-backed double wrap.

### 6. Move all `SECRET_RESOLVER_*` constants into `envHelpers` (implemented)

Most per-launch env var names live in `src/envHelpers.ts`, but
`SECRET_RESOLVER_MODE` and `SECRET_RESOLVER_SIGNAL_ON_STOP` are local constants
in `src/resolveLaunchConfig.ts`. Exporting them from one place would make the
env contract more discoverable and avoid small naming drift over time.

This also gives docs/tests one canonical import location when more launch knobs
are added.

Status: implemented on 2026-05-11. `envHelpers` now exports `MODE_VAR`,
`SIGNAL_ON_STOP_VAR`, `TOKEN_TAG_VAR`, and all account-selection env var
constants. `resolveLaunchConfig` and tests import those constants from one
place.

### 7. Replace direct `console.warn` parsing feedback with injected diagnostics (implemented)

`parseSecretResolverMode` and `parseSignalOnStop` log warnings directly through
`console.warn`. That keeps the helpers simple, but it means
`resolveLaunchConfig` cannot route invalid per-launch config through the same
user-facing warning path as envFile issues.

Suggested options:

- Return `{ value, warnings }` from parsers used for launch config.
- Or accept a tiny reporter callback with a default no-op/console reporter.

Either approach would keep pure parsing testable while giving the extension one
consistent warning surface.

Status: implemented on 2026-05-11. `parseSecretResolverMode` and
`parseSignalOnStop` accept an optional warning reporter and keep `console.warn`
as their default for standalone use. `resolveLaunchConfig` passes
`deps.showWarning`, so invalid launch marker values use the same user-facing
warning path as envFile issues.

### 8. Encapsulate cache namespaces (implemented)

`SecretCache` stores resolved refs, tokens, and account IDs by string key. The
token resolver now exposes `getCachedToken`, which is good, but the underlying
cache still has a mixed namespace: real `op://` refs and synthetic keys like
`__token__:<tag>` and `__account__:<email>`.

Suggested shape:

- Add narrow helpers such as `cacheResolvedRef`, `cacheToken`, and
  `cacheAccountId`, or a small wrapper like `SecretResolverCache` around
  `SecretCache`.
- Keep the cryptographic/obfuscation implementation in `SecretCache`, but move
  key naming to one domain-specific layer.

This makes cache-key changes much less invasive and avoids accidental key
reuse.

Status: implemented on 2026-05-11. `src/resolverCache.ts` now owns the
resolved-ref, token, and account cache namespaces with narrow helpers:
`getCachedResolvedRef` / `setCachedResolvedRef`, `getCachedToken` /
`setCachedToken`, and `getCachedAccountId` / `setCachedAccountId`.
`SecretCache` remains the obfuscated storage primitive.

### 9. Make git email persistence explicitly async or explicitly best-effort (implemented)

`WorkspaceStateGitEmailStore.set` and `clear` call `Memento.update` but discard
the returned thenable. That may be acceptable because the git-email cache is
only an optimization, but the contract currently looks synchronous while the
backing store is async.

Suggested options:

- Make `GitEmailStore.set` and `clear` async and await them from the VS Code
  wrapper path.
- Or keep them best-effort, but document that persistence failures are ignored
  and consider logging rejected updates.

The first option is more precise; the second keeps the pure resolver simpler.

Status: implemented on 2026-05-11. The `GitEmailStore` contract now documents
that `set` and `clear` are best-effort. `WorkspaceStateGitEmailStore` logs
rejected `Memento.update` calls with `console.warn` instead of silently
discarding persistence failures.

### 10. Treat tracker user messages as diagnostics, not normal notifications (implemented)

`debugAdapterProxy` currently shows information messages for captured PIDs and
sent signals. Those are useful while developing the stop-signal feature, but in
regular use they can feel noisy, especially for repeated debug sessions.

Suggested options:

- Gate them behind a setting such as `secretResolver.diagnostics`.
- Move them to `console.info`/output-channel logging and keep only warnings or
  errors as user-visible notifications.

This keeps the extension quieter without losing observability when debugging
the extension itself.

Status: implemented on 2026-05-11. Routine stop-signal progress messages
(captured PID and sent signal) now use `console.info`. User-visible warning
messages remain for situations where the requested signal sequence cannot find
a suitable target.

## Lower-priority cleanup

### 11. Clarify dotenv parser/writer symmetry

`formatDotenv` escapes values for `op run --env-file`; `parseEnvFile` is a
minimal parser for VS Code-style env files and does not fully unescape every
form that `formatDotenv` can write. That separation is fine, but the names make
round-tripping look more complete than it is.

Suggested options:

- Rename comments to state that `parseEnvFile` is for launch env files and
  `formatDotenv` is for generated `op run` env files.
- Or teach `parseEnvFile` to understand the writer's escape set and add full
  round-trip tests.

The first option is cheaper and probably enough unless generated files are ever
fed back into the parser outside tests.

### 12. Make process-command detection less string-split dependent

`isOpRunCommand` identifies wrappers by splitting the command string on
whitespace. That is enough for the current examples, but quoted paths or
unusual process listings could make it fragile.

Suggested direction:

- Preserve argv arrays where available, especially on Linux where
  `/proc/<pid>/cmdline` already provides NUL-separated arguments.
- Let `ProcessInfo` carry both `argv` and display `command`, then detect
  `op run` from `argv[0]` and `argv[1]`.

On macOS, `ps` still only provides a command string, so this would be a
best-effort hardening rather than a perfect parser.

### 13. Extract shared fake CLI builders in tests

This is outside `src`, but it supports maintainability of future source
changes: the account, token, and inject tests each create fake `op` or `git`
scripts with similar temp-dir and cleanup code. A shared test helper would
reduce friction when the suggested `OpCli` abstraction is introduced.

## Suggested implementation order

1. Extract the tracker collaborators while preserving the existing integration
   tests. Done on 2026-05-11.
2. Introduce an `OpCli` helper and migrate token/account resolution. Done on
   2026-05-11.
3. Tackle the smaller cleanup items as opportunistic follow-ups.

For substantial refactors, keep running the existing unit suite and then
`pnpm exec nx run stage:check` before merging. The current tests are strong
enough to support these changes if each step is kept small.
