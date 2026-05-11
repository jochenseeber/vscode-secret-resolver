# Code Review — `src/` (post-refactor)

Findings are ordered roughly by impact. Each item describes the current state,
the problem, and a concrete suggestion.

## What improved since the last review

The refactor made significant progress. Addressed items from the previous pass:

- `getTrimmedEnvValue` helper extracted and used for most env-var reads
- Account resolution extracted into `resolveLaunchAccount` (early-return chain)
- `buildSessionConfig` extracted to `sessionConfig.ts`
- `parseSignalOnStop` call moved into `parseLaunchOptions`
- `onDidSendMessage` split via the new `StopSignalController`
- `showInformationMessage` toasts replaced with `console.info`
- `WorkspaceStateGitEmailStore.updateBestEffort` now handles errors gracefully
- `OpCli` class consolidates CLI invocations; `resolverCache.ts` centralizes cache-key namespacing

---

## 1. `resolveLaunchConfig.ts` — `resolveLaunchAccount` and `resolveLaunchToken` swap null/undefined

**Current state.** The two helpers use opposite null/undefined conventions for
their "absent" and "error" states:

| Return value | `resolveLaunchAccount` | `resolveLaunchToken` |
| ------------ | ---------------------- | -------------------- |
| string       | resolved ID            | resolved token       |
| `null`       | no account configured  | **error — abort**    |
| `undefined`  | **error — abort**      | no token needed      |

The caller must use different checks depending on which result it examines:

```typescript
if (accountId === undefined) return undefined   // error for account
// …
if (serviceAccountToken === null) return undefined  // error for token
```

**Problem.** The inversion makes both call sites subtly wrong-looking and is a
trap when adding a third helper with either convention.

**Suggestion.** Pick one convention for "error / abort": `undefined`. Use
`null` for "absent / no value" in both helpers:

```typescript
// resolveLaunchAccount: null = no account, undefined = abort
// resolveLaunchToken:   null = no token,   undefined = abort

if (accountId === undefined) return undefined
// …
if (serviceAccountToken === undefined) return undefined
```

This makes every error check uniform and removes the need to remember which
helper uses which convention.

---

## 2. `stopSignalController.ts` — `vscode.window.showWarningMessage` prevents unit testing

**Current state.** Three paths in `signalProcessTree` call
`vscode.window.showWarningMessage(...)` directly:

```typescript
void vscode.window.showWarningMessage(`PID ${rootPid} has no children…`)
// …
void vscode.window.showWarningMessage(`PID ${rootPid} has no \`op\` child…`)
// …
void vscode.window.showWarningMessage(`\`op\` wrapper(s) … have no children…`)
```

**Problem.** Everything else in `StopSignalController` is already injectable
(kill, timers, process tree), but the warning surface is hard-wired to VS Code.
Unit tests cannot exercise those three branches without the extension host.

**Suggestion.** Add a `warn` parameter to the constructor, typed as
`(message: string) => void` (the same `WarningReporter` pattern used by
`parseSecretResolverMode` and `parseSignalOnStop`):

```typescript
constructor(
    private readonly sessionConfig: SecretResolverSessionConfig | undefined,
    private readonly kill: KillFn,
    private readonly setKillTimer: (cb: () => void, ms: number) => NodeJS.Timeout,
    private readonly clearKillTimer: (handle: NodeJS.Timeout) => void,
    private readonly getProcessTree: GetProcessTreeFn,
    private readonly warn: (message: string) => void = (msg) => {
        void vscode.window.showWarningMessage(msg)
    },
) {}
```

The `debugAdapterProxy.ts` constructor passes the default implicitly; unit
tests inject a recorder. The `vscode` import can then move inside the default
value, keeping it optional for tests.

---

## 3. `opCli.ts` — `withAccount` fragile command-aware arg insertion

**Current state.** `withAccount` special-cases the `item get` subcommand to
insert `--account` after the item ID at position 2:

```typescript
if (args[0] === "item" && args[1] === "get" && args.length >= 3) {
    return ["item", "get", args[2], "--account", account, ...args.slice(3)]
}
```

Other commands get `--account` inserted after the first two positional args.

**Problem.** Knowing where `--account` belongs requires inspecting the
subcommand. If the call site changes the arg order, or a future subcommand has
a different arity, the flag ends up in the wrong place silently. The `op` CLI
accepts `--account` as a global flag before the subcommand name, so a simpler
approach avoids this entirely.

**Suggestion.** Prepend `--account` globally:

```typescript
function withAccount(args: readonly string[], account: string | undefined): string[] {
    if (account === undefined || account.trim() === "") {
        return [...args]
    }

    const result = ["--account", account, ...args]
    return result
}
```

Verify against the actual `op` CLI that global-flag placement works for all
call sites (`account list`, `item list`, `item get`).

---

## 4. `resolverCache.ts` — return expressions violate project style rule

**Current state.** Every exported function returns directly from an expression:

```typescript
export function getCachedResolvedRef(cache, opRef) {
    return cache.get(RESOLVED_REF_PREFIX + opRef)
}

function accountKey(email: string): string {
    return ACCOUNT_PREFIX + email.toLowerCase()
}
```

**Problem.** The project rule states: "MUST not use return statements with
expressions or method calls, but create a local variable instead."

**Suggestion.** Introduce a local variable at each return site:

```typescript
export function getCachedResolvedRef(cache: SecretCache, opRef: string): string | undefined {
    const result = cache.get(RESOLVED_REF_PREFIX + opRef)
    return result
}

function accountKey(email: string): string {
    const key = ACCOUNT_PREFIX + email.toLowerCase()
    return key
}
```

---

## 5. `sessionConfig.ts` — return expressions + duplicated `SIGNAL_NAMES`

**Current state.**

`buildSessionConfig` and `parseSessionConfig` both return object literals
directly:

```typescript
return {
    steps,
    ...(tokenTag !== undefined ? { tokenTag } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
}
```

Additionally, `sessionConfig.ts` declares its own private `SIGNAL_NAMES` set
(line 80) that is identical to the private one in `envHelpers.ts`. Neither file
exports the set, so each file carries its own copy.

**Suggestion.** Apply the return-variable rule to the object literals:

```typescript
const config = {
    steps,
    ...(tokenTag !== undefined ? { tokenTag } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
}
return config
```

For `SIGNAL_NAMES`, export it from `envHelpers.ts` (it is already the
authoritative source for `SignalName`) and import it in `sessionConfig.ts`:

```typescript
// envHelpers.ts
export const SIGNAL_NAMES: ReadonlySet<SignalName> = new Set(["TERM", "KILL", "INT", "HUP"])

// sessionConfig.ts
import { SIGNAL_NAMES } from "./envHelpers"
```

---

## 6. `resolveLaunchConfig.ts` — `MODE_VAR` read inline; inconsistent with other vars

**Current state.**

```typescript
const modeValue = mergedEnv[MODE_VAR]
const mode = parseSecretResolverMode(
    typeof modeValue === "string" ? modeValue : null,
    deps.showWarning,
)
```

Every other env-var read in `parseLaunchOptions` uses `getTrimmedEnvValue`,
but `MODE_VAR` is read with a one-off inline pattern.

**Problem.** Minor inconsistency that will confuse a reader who scans the
function and expects a uniform pattern.

**Suggestion.** Use `getTrimmedEnvValue` directly:

```typescript
const mode = parseSecretResolverMode(
    getTrimmedEnvValue(mergedEnv, MODE_VAR),
    deps.showWarning,
)
```

`parseSecretResolverMode` already handles `null` (and empty strings via
trimming), so the result is identical.

---

## 7. `resolveLaunchConfig.ts` — `deps.getOpPath()` called multiple times

**Current state.** `deps.getOpPath()` is called at each of the three
resolution sites: inside `resolveLaunchAccount` (up to twice for the email and
git-config paths), inside `resolveLaunchToken`, and inside `resolveAllRefs`.

**Problem.** Each call re-reads VS Code configuration. Cheap but inconsistent:
the path could theoretically change between calls mid-launch. It also makes the
data flow opaque — a reader can't see "what `opPath` does this launch use?"
from the top-level function.

**Suggestion.** Read `opPath` once at the start of `resolveLaunchConfig` and
pass it down:

```typescript
const opPath = deps.getOpPath()
```

---

## 8. `resolveLaunchConfig.ts` — non-string env map is silently ignored

**Current state.**

```typescript
if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
    return { kind: "unchanged" }
}
```

**Problem.** An adapter like `cppdbg` uses `environment: [{name, value}]`
instead of a string map. If a user adds `SECRET_RESOLVER_MODE` or `op://` refs
to such a launch, they get no feedback when the extension silently no-ops.

**Suggestion.** Emit a warning when the env has op-refs but is the wrong shape:

```typescript
if (inlineEnv !== undefined && !isStringEnvMap(inlineEnv)) {
    if (hasOpRef(inlineEnv as EnvMap)) {
        deps.showWarning(
            "Secret Resolver: env is not a string map (e.g. cppdbg array shape) — op:// refs will not be resolved.",
        )
    }
    return { kind: "unchanged" }
}
```

---

## 9. `resolveLaunchConfig.ts` — `ResolveDeps` optional methods add defensive guards

**Current state.**

```typescript
resolveTokenForTag?: (…) => Promise<string>
resolveAccountForEmail?: (…) => Promise<string>
resolveAccountForGitConfig?: (…) => Promise<string>
```

Every call site must check `deps.xxx !== undefined`. In practice
`configProvider.ts` always provides all three; the optionality exists only to
ease test setup.

**Suggestion.** Make the fields required and export a test-helper factory:

```typescript
export function makeTestDeps(overrides: Partial<ResolveDeps>): ResolveDeps {
    const missing = (): Promise<never> =>
        Promise.reject(new Error("not wired in test"))
    return {
        resolveTokenForTag: missing,
        resolveAccountForEmail: missing,
        resolveAccountForGitConfig: missing,
        ...overrides,
    }
}
```

Making the fields required removes all `if (deps.xxx !== undefined)` guards
and makes the contract explicit.

---

## 10. `accountResolver.ts` — `getGitEmail` receives the `.git` dir not the working tree

**Current state.**

```typescript
const workDir = path.resolve(workspacePath ?? ".", subdir)
const gitDir = path.join(workDir, ".git")
// …
email = await getGitEmail(gitDir, signal)  // ← passes workDir/.git
```

Inside `getGitEmail` this becomes `git -C /path/to/repo/.git config --get user.email`.

**Problem.** `git -C` expects a working-tree directory. While git is often
forgiving about running inside `.git`, passing the work tree root is correct
and unambiguous. The `.git` path is useful only as the cache key (stable across
subdir aliases), not as the cwd.

**Suggestion.** Pass `workDir` to `getGitEmail` and keep `gitDir` solely for
the cache key:

```typescript
email = await getGitEmail(workDir, signal)  // repo root, not .git dir
gitEmailStore?.set(gitDir, email)           // cache key stays .git-relative
```

---

## 11. `configProvider.ts` — `_folder` used despite underscore prefix

**Current state.**

```typescript
async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    …
): … {
    // …
    resolveAccountForGitConfig: (subdir, opPath, signal) =>
        resolveAccountForGitConfig(…, _folder?.uri.fsPath, …),
```

**Problem.** The underscore prefix conventionally marks a parameter as unused.
Here it is actively used. Readers and linters treat it as unused.

**Suggestion.** Rename to `folder`.

---

## 12. `debugAdapterProxy.ts` — `SecretDebugAdapterTrackerFactory` has six positional parameters

**Current state.**

```typescript
export class SecretDebugAdapterTrackerFactory {
    constructor(
        private readonly registry: TempDirRegistry,
        private readonly kill: KillFn = …,
        private readonly setKillTimer: … = setTimeout,
        private readonly clearKillTimer: … = clearTimeout,
        private readonly getProcessTree: … = defaultGetProcessTree,
        private readonly getServiceAccountToken: … = () => undefined,
    ) {}
}
```

The call site in `extension.ts` passes only `registry` and
`getServiceAccountToken`, but must pass them positionally:

```typescript
new SecretDebugAdapterTrackerFactory(
    registry,
    (pid, sig) => { process.kill(pid, sig) },
    setTimeout,
    clearTimeout,
    undefined,
    (tag) => getCachedToken(cache, tag),
)
```

**Problem.** Six positional parameters with an `undefined` placeholder in the
middle is fragile. Adding or reordering parameters breaks call sites silently.

**Suggestion.** Replace parameters 2–6 with an options object:

```typescript
interface TrackerFactoryOptions {
    kill?: KillFn
    setKillTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
    clearKillTimer?: (handle: NodeJS.Timeout) => void
    getProcessTree?: GetProcessTreeFn
    getServiceAccountToken?: (tag: string) => string | undefined
}

export class SecretDebugAdapterTrackerFactory {
    constructor(
        private readonly registry: TempDirRegistry,
        private readonly options: TrackerFactoryOptions = {},
    ) {}
}
```

`extension.ts` becomes self-documenting:

```typescript
new SecretDebugAdapterTrackerFactory(registry, {
    getServiceAccountToken: (tag) => getCachedToken(cache, tag),
})
```

---

## 13. `opInject.ts` — two normalizers look identical but differ subtly

**Current state.** `normalizeOpCliError` (exported) and `normalizeError`
(private) look nearly identical but differ in two important ways:

| Behavior     | `normalizeOpCliError` | `normalizeError`                  |
| ------------ | --------------------- | --------------------------------- |
| AbortError   | re-thrown as-is       | wrapped in `OpInjectAbortedError` |
| error prefix | `"op failed:"`        | `"op inject failed:"`             |

**Problem.** A reader who sees two near-identical functions assumes one is a
leftover and can be deleted. The meaningful differences are not visible without
careful diffing.

**Suggestion.** Add a short comment to each explaining why it exists
separately from the other. One line per function is sufficient.

---

## 14. `extension.ts` — `signalHandlersInstalled` not explained

**Current state.** `let signalHandlersInstalled = false` sits at module scope,
separately from `ExtensionState`.

**Problem.** It looks like it was missed in the grouping refactor. A reader may
wonder why it is not part of `ExtensionState`.

**Suggestion.** Add a one-line comment:

```typescript
// Process-level flag; separate from ExtensionState because signal handlers
// survive deactivate/reactivate cycles and must only be installed once.
let signalHandlersInstalled = false
```

---

## 15. `tempDirRegistry.ts` — `drain` duplicates the spread from `snapshot`

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

**Suggestion.** Have `drain` call `snapshot`:

```typescript
drain(): string[] {
    const dirs = this.snapshot()
    this.dirs.clear()
    return dirs
}
```

---

## 16. `dotenv.ts` — empty-string quoting is implicit

**Current state.**

```typescript
if (value.length > 0 && SAFE_UNQUOTED.test(value)) {
    return value
}
// … falls through to double-quoted path
```

**Problem.** The `value.length > 0` guard is load-bearing: an empty string
`""` must be written as `KEY=""` because `op run` rejects bare empty
assignments (`KEY=`). But the reason for the guard is not obvious.

**Suggestion.** Add a one-line comment:

```typescript
// Empty values must be quoted; op run rejects bare KEY= assignments.
if (value.length > 0 && SAFE_UNQUOTED.test(value)) {
```

---

## Summary table

| #  | File                     | Category                                            | Effort  |
| -- | ------------------------ | --------------------------------------------------- | ------- |
| 1  | `resolveLaunchConfig.ts` | Align null/undefined semantics across tri-states    | Small   |
| 2  | `stopSignalController.ts`| Inject `warn` callback; remove vscode dependency    | Small   |
| 3  | `opCli.ts`               | Simplify `withAccount` to global-flag prepend       | Small   |
| 4  | `resolverCache.ts`       | Return via local variable (style rule)              | Trivial |
| 5  | `sessionConfig.ts`       | Return via local variable; export `SIGNAL_NAMES`    | Trivial |
| 6  | `resolveLaunchConfig.ts` | Use `getTrimmedEnvValue` for `MODE_VAR`             | Trivial |
| 7  | `resolveLaunchConfig.ts` | Read `opPath` once at top                           | Trivial |
| 8  | `resolveLaunchConfig.ts` | Warn on non-string env map with op-refs             | Small   |
| 9  | `resolveLaunchConfig.ts` | Make `ResolveDeps` methods required                 | Medium  |
| 10 | `accountResolver.ts`     | Pass `workDir` not `gitDir` to `getGitEmail`        | Small   |
| 11 | `configProvider.ts`      | Rename `_folder` → `folder`                         | Trivial |
| 12 | `debugAdapterProxy.ts`   | Options object for factory constructor              | Medium  |
| 13 | `opInject.ts`            | Document the two normalizers' distinction           | Trivial |
| 14 | `extension.ts`           | Comment on `signalHandlersInstalled`                | Trivial |
| 15 | `tempDirRegistry.ts`     | `drain` delegates to `snapshot`                     | Trivial |
| 16 | `dotenv.ts`              | Comment on empty-string quoting                     | Trivial |
