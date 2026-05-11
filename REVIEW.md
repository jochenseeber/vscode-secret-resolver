# Code Review — `src/`

Findings are grouped by concern and ordered roughly by impact. Each item
describes the current state, the problem, and a concrete suggestion.

---

## 1. `resolveLaunchConfig.ts` — env-var normalization repeated four times

**Current state.** Four env vars are coerced from the merged map into
`string | null` with identical inline expressions:

```typescript
const tokenTagValue = merged[TOKEN_TAG_VAR]
const tokenTag = typeof tokenTagValue === "string" && tokenTagValue.trim() !== ""
    ? tokenTagValue.trim()
    : null

const accountIdValue = merged[ACCOUNT_ID_VAR]
let accountId: string | null = typeof accountIdValue === "string" && accountIdValue.trim() !== ""
    ? accountIdValue.trim()
    : null
// … same pattern again for ACCOUNT_EMAIL_VAR and ACCOUNT_GIT_CONFIG_VAR
```

**Problem.** Duplicated logic and noise; easy to introduce an inconsistency
when adding a fifth var.

**Suggestion.** Extract a one-liner helper:

```typescript
function getEnvVar(env: EnvMap, key: string): string | null {
    const value = env[key]
    const trimmed = typeof value === "string" ? value.trim() : ""
    return trimmed !== "" ? trimmed : null
}
```

Then every call site becomes `getEnvVar(merged, TOKEN_TAG_VAR)`.

---

## 2. `resolveLaunchConfig.ts` — account resolution is a cascade of mutable `if`-blocks

**Current state.** Account resolution proceeds through three sequential
strategies, each guarded by `if (accountId === null)`:

```typescript
let accountId: string | null = …  // from ACCOUNT_ID_VAR

if (accountId === null) {
    // try ACCOUNT_EMAIL_VAR
}

if (accountId === null) {
    // try ACCOUNT_GIT_CONFIG_VAR
}
```

**Problem.** `accountId` is reassigned inside each block, making the control
flow implicit. Adding a fourth strategy requires another block in the right
place.

**Suggestion.** Extract a private `resolveAccountId` function that takes `merged`
and returns `Promise<string | null>`. Inside it, try each strategy in sequence
with early returns:

```typescript
async function resolveAccountId(
    merged: EnvMap,
    deps: ResolveDeps,
    signal?: AbortSignal,
): Promise<string | null> {
    const directId = getEnvVar(merged, ACCOUNT_ID_VAR)
    if (directId !== null) return directId

    const email = getEnvVar(merged, ACCOUNT_EMAIL_VAR)
    if (email !== null && deps.resolveAccountForEmail !== undefined) {
        return deps.resolveAccountForEmail(email, deps.getOpPath(), signal)
    }

    const subdir = getEnvVar(merged, ACCOUNT_GIT_CONFIG_VAR)
    if (subdir !== null && deps.resolveAccountForGitConfig !== undefined) {
        return deps.resolveAccountForGitConfig(subdir, deps.getOpPath(), signal)
    }

    return null
}
```

The `try/catch` wrappers that call `deps.showError` and `return undefined` stay
in `resolveLaunchConfig` around the single call to `resolveAccountId`.

---

## 3. `resolveLaunchConfig.ts` — `deps.getOpPath()` called multiple times

**Current state.** `deps.getOpPath()` is invoked up to four times in one
execution:

```typescript
accountId = await deps.resolveAccountForEmail(email, deps.getOpPath(), signal)
// …
accountId = await deps.resolveAccountForGitConfig(gitSubdir, deps.getOpPath(), signal)
// …
serviceAccountToken = await deps.resolveTokenForTag(tokenTag, deps.getOpPath(), signal, …)
// …
resolved = await deps.runner.resolve(missing, deps.getOpPath(), signal, …)
```

**Problem.** Each call re-reads VS Code configuration. While cheap, it means the
`opPath` could theoretically change between calls during a long resolution.
It also obscures where the path comes from.

**Suggestion.** Read it once at the top of `resolveLaunchConfig`:

```typescript
const opPath = deps.getOpPath()
```

---

## 4. `resolveLaunchConfig.ts` — `attachSessionConfig` is a dense boolean

**Current state.**

```typescript
const attachSessionConfig = (signalOnStop !== null || (tokenTag !== null && useOpRun) || accountId !== null)
    && TERMINAL_CONSOLES.has(consoleKind)
```

**Problem.** Combining three unrelated conditions in a single expression makes
it hard to reason about which feature triggers the attachment.

**Suggestion.** Build the session config unconditionally and only attach if it
carries anything useful:

```typescript
function buildSessionConfig(
    signalOnStop: SignalStep[] | null,
    tokenTag: string | null,
    useOpRun: boolean,
    accountId: string | null,
): SecretResolverSessionConfig | null {
    const steps = signalOnStop ?? []
    const hasTokenTag = tokenTag !== null && useOpRun
    const hasAccount = accountId !== null
    if (steps.length === 0 && !hasTokenTag && !hasAccount) return null

    return {
        steps,
        ...(hasTokenTag ? { tokenTag: tokenTag! } : {}),
        ...(hasAccount ? { accountId: accountId! } : {}),
    }
}
```

Then in `resolveLaunchConfig`:

```typescript
if (TERMINAL_CONSOLES.has(consoleKind)) {
    const sessionConfig = buildSessionConfig(signalOnStop, tokenTag, useOpRun, accountId)
    if (sessionConfig !== null) {
        ;(next as Record<string, unknown>)[SECRET_RESOLVER_CONFIG_FIELD] = sessionConfig
    }
}
```

---

## 5. `resolveLaunchConfig.ts` — `SIGNAL_ON_STOP_VAR` read after final env is built

**Current state.** `parseSignalOnStop` is called at the very end of the
function, after `finalEnv` and `next` have already been constructed:

```typescript
const next: vscode.DebugConfiguration = { ...config, env: finalEnv }
// …
const signalOnStop = parseSignalOnStop(
    typeof merged[SIGNAL_ON_STOP_VAR] === "string"
        ? (merged[SIGNAL_ON_STOP_VAR] as string)
        : null,
)
```

**Problem.** All reads from `merged` (mode, console kind, token tag, account
id, signal-on-stop) should happen in one place at the top of the function. The
current ordering implies `signalOnStop` depends on `finalEnv`, which it does
not.

**Suggestion.** Move the `parseSignalOnStop` call to the "read all config from
merged" block immediately after `stripped` is computed.

---

## 6. `resolveLaunchConfig.ts` — non-string `env` map passes through silently

**Current state.**

```typescript
if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
    return config
}
```

**Problem.** Adapters like `cppdbg` use `environment: Array<{name,value}>` instead
of a string map. The extension silently does nothing for these, which is correct
behaviour — but a user who adds `SECRET_RESOLVER_MODE` to a cppdbg launch and
wonders why nothing happens gets no feedback.

**Suggestion.** Add a warning if the env contains op-refs but the shape is wrong:

```typescript
if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
    if (hasOpRef(inlineEnv as Record<string, unknown>)) {
        deps.showWarning(
            "Secret Resolver: env is not a string map (e.g. cppdbg array shape) — op:// refs will not be resolved.",
        )
    }
    return config
}
```

---

## 7. `resolveLaunchConfig.ts` — `null` / `undefined` boundary crossing

**Current state.** `accountId` and `tokenTag` are `string | null` inside
`resolveLaunchConfig`, but `SecretResolverSessionConfig` and the called helpers
use `string | undefined`. This causes:

```typescript
accountId ?? undefined   // appears multiple times
```

**Problem.** The null-vs-undefined split adds noise. The TypeScript type system
provides no safety benefit if you have to escape it at every call site.

**Suggestion.** Pick one convention throughout the file. Since `null` is the
project-wide convention for "currently unavailable", keep `null` internally and
convert to `undefined` only at the boundary in `buildSessionConfig` (or wherever
`SecretResolverSessionConfig` is assembled). This consolidates the conversion
to one place rather than scattering `?? undefined` everywhere.

---

## 8. `accountResolver.ts` — `getGitEmail` receives the `.git` dir, not the working tree

**Current state.**

```typescript
const workDir = path.resolve(workspacePath ?? ".", subdir)
const gitDir = path.join(workDir, ".git")
// …
email = await getGitEmail(gitDir, signal)   // passes workDir/.git
```

Inside `getGitEmail`:

```typescript
;({ stdout } = await execFileAsync(
    "git",
    ["-C", cwd, "config", "--get", "user.email"],
    …
))
```

**Problem.** `git -C /path/to/repo/.git config …` changes into the `.git`
directory before running. While git is often forgiving about this (it can
discover the work tree from inside `.git`), passing the working-tree root is
the correct and unambiguous invocation. The `.git` path is useful only as a
**cache key** (it's stable even if the subdir is `.`), not as the cwd.

**Suggestion.** Pass `workDir` to `getGitEmail`, and keep `gitDir` solely as
the cache key:

```typescript
const cachedEmail = gitEmailStore?.get(gitDir)
if (cachedEmail !== undefined) {
    email = cachedEmail
}
else {
    email = await getGitEmail(workDir, signal)   // ← repo root, not .git dir
    gitEmailStore?.set(gitDir, email)
}
```

---

## 9. `opInject.ts` — two error normalizers look identical but differ subtly

**Current state.** `normalizeOpCliError` (exported, used by `accountResolver`
and `tokenResolver`) and `normalizeError` (private, used by
`DefaultOpInjectRunner`) look nearly identical. The key differences are:

| | `normalizeOpCliError` | `normalizeError` |
|---|---|---|
| AbortError | re-thrown as-is | wrapped in `OpInjectAbortedError` |
| non-zero exit prefix | `"op failed:"` | `"op inject failed:"` |

**Problem.** A reader who sees two nearly-identical functions assumes one is a
duplicate of the other and that only one should exist. The meaningful
differences are not obvious without careful diffing.

**Suggestion.** Add a brief comment to each function explaining why it is
distinct from the other:

```typescript
/**
 * Normalizes op CLI errors for account/token resolution callers.
 * Re-throws AbortError as-is so callers can detect cancellation via
 * AbortSignal. Contrast with `normalizeError` below, which wraps AbortError
 * in `OpInjectAbortedError` for the inject runner's callers.
 */
export function normalizeOpCliError(err: unknown, opPath: string): Error { … }

/**
 * Normalizes op CLI errors for `DefaultOpInjectRunner`. Wraps AbortError in
 * `OpInjectAbortedError` so `resolveLaunchConfig` can distinguish
 * cancellation from other failures without depending on the AbortSignal.
 * Contrast with `normalizeOpCliError` above.
 */
function normalizeError(err: unknown, opPath: string): Error { … }
```

---

## 10. `debugAdapterProxy.ts` — `SecretDebugAdapterTrackerFactory` has six positional parameters

**Current state.**

```typescript
new SecretDebugAdapterTrackerFactory(
    registry,
    (pid, sig) => { process.kill(pid, sig) },
    setTimeout,
    clearTimeout,
    undefined,          // ← placeholder for getProcessTree
    (tag) => getCachedToken(cache, tag),
)
```

**Problem.** Six positional parameters with one `undefined` placeholder is
fragile: adding or reordering parameters silently breaks call sites. The
`undefined` also hides that a default is being accepted.

**Suggestion.** Replace positional injection parameters 2–6 with an options
object:

```typescript
interface TrackerFactoryOptions {
    kill?: KillFn
    setKillTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
    clearKillTimer?: (handle: NodeJS.Timeout) => void
    getProcessTree?: GetProcessTreeFn
    getServiceAccountToken?: (tag: string) => string | undefined
}

export class SecretDebugAdapterTrackerFactory implements vscode.DebugAdapterTrackerFactory {
    constructor(
        private readonly registry: TempDirRegistry,
        private readonly options: TrackerFactoryOptions = {},
    ) {}
    // …
}
```

The call site in `extension.ts` becomes self-documenting:

```typescript
new SecretDebugAdapterTrackerFactory(registry, {
    getServiceAccountToken: (tag) => getCachedToken(cache, tag),
})
```

---

## 11. `debugAdapterProxy.ts` — `onDidSendMessage` handles two unrelated concerns

**Current state.** The method:
1. Checks for a DAP `exited` event and cancels the pending kill timer.
2. Checks for a `runInTerminal` request and rewrites it (env file, PID file, args).

**Problem.** Two distinct responsibilities in one method make it harder to read
and test each behaviour independently.

**Suggestion.** Extract private methods:

```typescript
onDidSendMessage(message: unknown): void {
    this.handleExitedEvent(message)
    this.handleRunInTerminalRequest(message)
}

private handleExitedEvent(message: unknown): void {
    if (isDapEvent(message, "exited")) {
        this.programExited = true
        this.cancelPendingKill()
    }
}

private handleRunInTerminalRequest(message: unknown): void {
    if (!isRunInTerminalRequest(message)) return
    // … existing rewrite logic …
}
```

---

## 12. `debugAdapterProxy.ts` — informational `showInformationMessage` calls are noisy

**Current state.**

```typescript
void vscode.window.showInformationMessage(`Launched process has PID ${pid}`)
// …
void vscode.window.showInformationMessage(`Sent ${signal} to PID ${target.pid}`)
```

**Problem.** These appear as notification toasts in VS Code's UI on every
debug session start and on every signal step. Most users will find them
distracting once the feature is known to work.

**Suggestion.** Replace with `console.log` (which writes to the extension host
output channel, visible in *Output → Secret Resolver* if you register one, or
in the developer console). Reserve `showInformationMessage` for events users
need to act on. The warning messages (`showWarningMessage`) for "no children to
signal" are appropriate and should stay.

---

## 13. `configProvider.ts` — `_folder` is used despite the underscore prefix

**Current state.**

```typescript
async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    …
): Promise<…> {
    // …
    resolveAccountForGitConfig: (subdir, opPath, signal) =>
        resolveAccountForGitConfig(subdir, opPath, this.#cache, signal, _folder?.uri.fsPath, …),
```

**Problem.** The `_` prefix conventionally signals "unused". Readers and linters
treat it that way. A reader may incorrectly conclude `_folder` is a no-op or may
suppress a "used" diagnostic with it.

**Suggestion.** Rename to `folder`:

```typescript
async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    …
```

---

## 14. `extension.ts` — `signalHandlersInstalled` is module-level state outside `ExtensionState`

**Current state.** `let signalHandlersInstalled = false` sits at module scope
separately from the newly-grouped `state`.

**Problem.** Minor inconsistency — it's the same category of module-level
mutable state but was left out of the grouping refactor. It doesn't belong in
`ExtensionState` (process handlers are truly per-process, not per-activation),
but a comment would clarify this.

**Suggestion.** Add a brief comment:

```typescript
// Process-level flag; separate from ExtensionState because signal handlers
// survive deactivate/reactivate cycles and must only be installed once.
let signalHandlersInstalled = false
```

---

## 15. `tempDirRegistry.ts` — `drain` duplicates the spread in `snapshot`

**Current state.**

```typescript
snapshot(): string[] {
    const dirs = [...this.dirs]
    return dirs
}

drain(): string[] {
    const snapshot = [...this.dirs]
    this.dirs.clear()
    return snapshot
}
```

**Problem.** Minor duplication; if the collection type changes, both methods
need updating.

**Suggestion.** Have `drain` call `snapshot`:

```typescript
drain(): string[] {
    const dirs = this.snapshot()
    this.dirs.clear()
    return dirs
}
```

---

## 16. `resolveLaunchConfig.ts` — `ResolveDeps` optional methods create defensive checks

**Current state.** Three of the six `ResolveDeps` fields are optional:

```typescript
resolveTokenForTag?: (…) => Promise<string>
resolveAccountForEmail?: (…) => Promise<string>
resolveAccountForGitConfig?: (…) => Promise<string>
```

**Problem.** Every call site must guard `if (deps.xxx !== undefined)`. In
practice `configProvider.ts` always provides all three; the optional
declaration exists only to simplify test setup.

**Suggestion.** Provide no-op defaults in the interface or use a helper:

```typescript
function noAccount(_: string, __: string): Promise<string> {
    return Promise.resolve("")
}

// … or make them required and provide a helper for tests:
export function makeTestDeps(overrides: Partial<ResolveDeps>): ResolveDeps {
    return {
        resolveTokenForTag: () => Promise.reject(new Error("not wired")),
        resolveAccountForEmail: () => Promise.reject(new Error("not wired")),
        resolveAccountForGitConfig: () => Promise.reject(new Error("not wired")),
        ...overrides,
    }
}
```

Making the fields required eliminates all the `if (deps.xxx !== undefined)`
guards in the resolver and makes the interface contract explicit.

---

## 17. `dotenv.ts` — empty-string quoting is implicit

**Current state.**

```typescript
function formatValue(value: string): string {
    if (value.length > 0 && SAFE_UNQUOTED.test(value)) {
        return value
    }
    // … double-quote path
}
```

**Problem.** An empty string `""` falls through to the quoted path and becomes
`""`. This is correct for `op run --env-file`, but the reason the guard
includes `value.length > 0` is not obvious.

**Suggestion.** Add a brief inline comment:

```typescript
// Empty values must be quoted; op run rejects bare empty assignments.
if (value.length > 0 && SAFE_UNQUOTED.test(value)) {
```

---

## Summary table

| # | File | Category | Effort |
|---|---|---|---|
| 1 | `resolveLaunchConfig.ts` | Extract `getEnvVar` helper | Small |
| 2 | `resolveLaunchConfig.ts` | Extract `resolveAccountId` function | Medium |
| 3 | `resolveLaunchConfig.ts` | Read `opPath` once | Trivial |
| 4 | `resolveLaunchConfig.ts` | Extract `buildSessionConfig` | Small |
| 5 | `resolveLaunchConfig.ts` | Move `parseSignalOnStop` call earlier | Trivial |
| 6 | `resolveLaunchConfig.ts` | Warn on non-string env map with op-refs | Small |
| 7 | `resolveLaunchConfig.ts` | Consolidate null/undefined conversion | Small |
| 8 | `accountResolver.ts` | Pass `workDir` not `gitDir` to `getGitEmail` | Small |
| 9 | `opInject.ts` | Document two normalizers' distinction | Trivial |
| 10 | `debugAdapterProxy.ts` | Options object for factory constructor | Medium |
| 11 | `debugAdapterProxy.ts` | Split `onDidSendMessage` into two methods | Small |
| 12 | `debugAdapterProxy.ts` | Replace toast messages with console.log | Trivial |
| 13 | `configProvider.ts` | Rename `_folder` → `folder` | Trivial |
| 14 | `extension.ts` | Comment on `signalHandlersInstalled` | Trivial |
| 15 | `tempDirRegistry.ts` | `drain` delegates to `snapshot` | Trivial |
| 16 | `resolveLaunchConfig.ts` | Make `ResolveDeps` methods required | Medium |
| 17 | `dotenv.ts` | Comment on empty-string quoting | Trivial |
