# Code Style and Conventions

## TypeScript

- **Quotes**: double quotes for non-interpolated strings (`"op"`, `"cache"`)
- **Numeric literals**: use `_` as thousands separator (`64 * 1_024 * 1_024`, `5_000`)
- **Union types** preferred over enums for simple finite string sets (e.g. `SignalName`, `SecretResolverMode`)
- **Null vs undefined**: `null` = currently unavailable; `undefined` = not initialized / optional parameter
- **No return expressions**: return statements must not contain expressions or method calls — store in a named local variable first
- **Named interfaces** for reusable types; inline anonymous types only for single-use simple structures
- **Objects for fixed-key maps** (e.g. `NODE_SIGNALS: Record<SignalName, NodeJS.Signals>`) rather than switch/if-else lookups

## General

- **No comments explaining WHAT** — well-named identifiers do that. Comments only for non-obvious WHY (hidden constraints, workarounds, subtle invariants)
- **Return happy path at end**, early returns for errors/shortcuts
- **No silent failures** — all errors either handled, logged, or propagated
- **Factory/injection over singletons** — dependencies passed via constructor or method parameter
- **No global mutable state** except the module-level `state: ExtensionState | undefined` and `signalHandlersInstalled` in `extension.ts` (documented exceptions)
- **Factor out common code** — e.g. `normalizeOpCliError` in `opInject.ts` shared by `accountResolver` and `tokenResolver`; resolver cache helpers in `resolverCache.ts`
- **Classes MUST NOT access constants/implementation details of other modules** — use exported helpers (e.g. `getCachedToken` not `CACHE_KEY_PREFIX`)

## Error Handling

- Custom error classes with `.name` for all typed errors
- `OpCliNotFoundError`, `OpInjectError`, `OpInjectAbortedError` from `opInject.ts`
- `AccountNotFoundError`, `GitEmailNotFoundError` from `accountResolver.ts`
- `TokenNotFoundError`, `TokenCredentialMissingError` from `tokenResolver.ts`
- `EnvFileNotFoundError` from `dotenv.ts`
- Two normalizers in `opInject.ts` with distinct semantics:
  - `normalizeOpCliError` (exported): re-throws AbortError as-is; used by account/token resolvers
  - `normalizeError` (private): wraps AbortError in `OpInjectAbortedError`; used by inject runner

## Formatting Tool

dprint (configured in `dprint.json`). Run `pnpm exec nx run format:dprint` to apply.
ESLint handles import ordering and other lint rules — `pnpm exec nx run format:eslint`.

## Spell Checking

`cspell` with `cspell.yaml` + `cspell.dict`. Add unknown technical words to `cspell.dict` in lowercase singular, alphabetical order. Suppress on test-data lines with `// cspell:disable-line`.

## Commit Convention

Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
Releases use `chore: release X.Y.Z` / `chore: start X.Y.Z-dev development`.
