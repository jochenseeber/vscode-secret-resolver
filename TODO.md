# Refactor TODOs

## Replace `toNodeSignal` switch with a lookup object

`toNodeSignal` in `src/debugAdapterProxy.ts` uses a `switch` statement with four
literal cases mapping `SignalName → NodeJS.Signals`. Both the general rule
(prefer dictionaries over conditionals for value lookup) and the TypeScript rule
(MAY use objects for fixed-key pairs) point to a `const` object:

```ts
const NODE_SIGNALS: Record<SignalName, NodeJS.Signals> = {
    TERM: "SIGTERM",
    KILL: "SIGKILL",
    INT:  "SIGINT",
    HUP:  "SIGHUP",
}
```

Replace the `switch` body with `return NODE_SIGNALS[name]`. As a side effect,
`isSignalStep` in the same file can simplify its signal validation to
`s.signal in NODE_SIGNALS` instead of four explicit string comparisons.

## Deduplicate `normalizeExecError`

`src/accountResolver.ts` and `src/tokenResolver.ts` each contain a private
`normalizeExecError` function with identical logic (ENOENT → `OpCliNotFoundError`,
AbortError re-thrown as-is, non-zero exit → `OpInjectError` with "op failed:"
prefix). The rule requires factoring out common code.

- Export the shared version as `normalizeOpCliError` from `src/opInject.ts`
  (where the error classes live). *(opInject.ts — done)*
- Remove the private copies from `accountResolver.ts` and `tokenResolver.ts` and
  replace each call site with an import of `normalizeOpCliError`.

## Export a `getCachedToken` helper from `tokenResolver.ts`

`src/extension.ts` constructs the cache key `` `__token__:${tag}` `` directly,
relying on the private `CACHE_KEY_PREFIX` constant defined inside
`tokenResolver.ts`. The rule says classes should not access implementation
details of other modules.

- Export `getCachedToken(cache: SecretCache, tag: string): string | undefined`
  from `src/tokenResolver.ts` that encapsulates the key format.
- Update `src/extension.ts` to call `getCachedToken(cache, tag)` instead of
  building the key by hand.

## Group module-level state in `extension.ts`

`src/extension.ts` has three separate module-level mutable variables
(`activeCache`, `activeRegistry`, `activeGitEmailStore`) that are always created
and cleared together. The rule prohibits scattered global state.

- Combine them into a single `interface ExtensionState { cache: SecretCache;
  registry: InMemoryTempDirRegistry; gitEmailStore: GitEmailStore }` and keep
  one `let state: ExtensionState | undefined` variable. Access as
  `state?.cache`, `state?.registry`, etc.

## Local variables for return expressions

The rule says return statements must not contain expressions or method calls —
the result must be stored in a named local variable first. This applies
throughout the codebase. Key instances:

- `src/envHelpers.ts`: `mergeEnv` (`return { ...fileMap, ... }`). *(isOpRef done)*
- `src/dotenv.ts`: `formatDotenv` (ternary), `formatValue` (template literal).
- `src/launchRewrite.ts`: `isRunInTerminalRequest` (compound boolean),
  `buildOpRunArgs` (array literal).
- `src/secretCache.ts`: `get` (`return this.#decrypt(blob)`), `#hashKey`
  (chained `createHmac(...).update(...).digest(...)`), `#encrypt` and `#decrypt`
  (`return Buffer.concat([...])`).
- `src/processTree.ts`: `isOpRunCommand` (compound boolean),
  `defaultGetProcessTree` (`return entries.map(...)`).
- `src/configProvider.ts`: `WorkspaceStateGitEmailStore.get` (optional-chain
  expression), `resolveDebugConfigurationWithSubstitutedVariables`
  (`return await resolveLaunchConfig(...)`).
- `src/tempDirRegistry.ts`: `snapshot` (`return [...this.dirs]`).
- `src/debugAdapterProxy.ts`: `isDapEvent`, `isDapRequest`,
  `isRunInTerminalResponse`, `shouldTerminateOnDisconnect`, `isSignalStep`
  (all return compound boolean expressions).

## Verify

Run `nx run check:types` and `nx run test:unit` after all changes and fix any
type errors or test failures before closing out the refactor.
