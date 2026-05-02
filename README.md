# Secret Resolver for VS Code

A VS Code extension that resolves 1Password secret references
(`op://VaultName/ItemID/field`) in debug-launch environment variables.

## Usage

Add `op://` references to `env` and/or `envFile` in your `launch.json` and we
resolve them when launching:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node",
            "request": "launch",
            "name": "Launch with Secrets",
            "program": "${workspaceFolder}/app.js",
            "console": "internalConsole",
            "env": {
                "DATABASE_URL": "op://Development/Database/connection-string",
                "API_KEY": "op://Development/API/key"
            },
            "envFile": "${workspaceFolder}/.env"
        }
    ]
}
```

If you provide an `envFile`, we parse it and merge it with the inline `env` —
inline values win when there is a conflict. Either way, the adapter sees a
clean environment with no `op://` references and no `SECRET_RESOLVER_*`
variables.

## Configuration

All per-launch configuration is done through `SECRET_RESOLVER_*` environment
variables in `env` or `envFile`. We strip every one of them before the program
sees its environment, so they are truly launch-only metadata.

### Mode (`SECRET_RESOLVER_MODE`)

There are two ways we can resolve `op://` references — `cache` mode and `op`
mode. The default mode is `cache`. To force a specific mode:

```json
{
    "console": "integratedTerminal",
    "env": {
        "SECRET_RESOLVER_MODE": "cache",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

Both modes have advantages als well as disadvantages and limitations, mostly
because to modify the launch command, we have to use VSCode's tracker API, and
although this API is documented as observation-only, modifying the command
actually works for `"console": "integratedTerminal"`. So we happily misuse this
API…

In `cache` mode, the secrets are resolved using a proper and legal
`DebugConfigurationProvider`, and no API contract is violated. However, when
launching in a terminal, VSCode goes ahead and prints the env including all
secrets on the command line, which is not exactly the smart thing to do. In
order to mitigate this, we still try to wrap the command in `op run` to hide
the secrets, which may or may not succeed, depending on how prickly VSCode is
with its API. Worst case we launch, and display the env variables. Also note,
that since the secrets are already resolved, `op run` cannot mask them in the
command output, so if your app prints secrets, they are shown on the console
for the world to see. No picking questionable passwords…

In `op` mode, we fully depend on the misuse of the tracker API, so this only
works with `"console": "integratedTerminal"`. The advantage then is that the
secret resolution is done by `op run`, so the secrets never enter VSCode, and
`op` is able to filter the output, so any secrets printed by your app are
redacted.

To sum it up: If you are on the VSCode team and are reading this, please
provide us with a proper API to manipulate the launch command.

### Service account token (`SECRET_RESOLVER_TOKEN_TAG`)

By default we use whatever `op` session is already active in the shell — either
from `op signin` or an `OP_SERVICE_ACCOUNT_TOKEN` in VS Code's own environment.
If you want to keep this out of VSCode, you can tell the extension to fetch a
dedicated service account token from the vault for a specific launch. Store the
token in an **API Credential** vault item's `credential` field, tag the item
(e.g. `dev-secrets`), and reference the tag:

```json
{
    "env": {
        "SECRET_RESOLVER_TOKEN_TAG": "dev-secrets"
    }
}
```

When the launch starts, we run
`op item list --tags dev-secrets --categories "API Credential"`, fetch the
`credential` field, and use the value as `OP_SERVICE_ACCOUNT_TOKEN` for every
`op` call during this launch. The resolved token is cached for the VS Code
session; run `Secret Resolver: Clear Cache` if you need a fresh one.

For terminal-mode launches we write the token to a separate `token.env` file
(same `0600`/`0700` temp dir as the main env file) and compose a double
`op run` wrap to prevent VSCode from spilling your secrets on the command line:
`op run --env-file=token.env -- op run --env-file=env -- <orig args>`. For
`internalConsole` cache-mode launches we pass the token directly to the
in-process `op inject` call via its child environment.

### Account selection

If you have multiple 1Password accounts, you can pin a launch to one of them.
We support three ways to do this, checked in priority order: by literal account
ID, by email address, and by the git identity of a project subdirectory.

`SECRET_RESOLVER_ACCOUNT_ID` is the most direct — give us the account shorthand
or UUID and we pass `--account <id>` to every `op` call for this launch:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_ID": "SOME_ACCOUNT_ID",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

`SECRET_RESOLVER_ACCOUNT_EMAIL` does the same thing but from an email address.
We run `op account list --format json` and match by email (case-insensitive),
then cache the email → UUID result in `SecretCache` so we only call
`op account list` once per session:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_EMAIL": "user@company.com",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

`SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` specifies a relative subdirectory path
where we read `user.email` from its `.git/config`, then look up the matching
account as above. Use `.` for the workspace root, or leave it empty (or omit
the var entirely) to disable this lookup:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_GIT_CONFIG": "packages/api",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

We cache both mappings for the session — the `.git`-dir → email lookup in
`workspaceState`, and the email → UUID lookup in `SecretCache`. Both are
cleared by `Secret Resolver: Clear Cache` and on extension start/stop.

### Signal on stop (`SECRET_RESOLVER_SIGNAL_ON_STOP`)

When you click Stop, many debug adapters simply detach rather than stop the
process — the program keeps running in the terminal.
`SECRET_RESOLVER_SIGNAL_ON_STOP` lets you configure a sequence of signals to
send to the process to stop it instead:

```json
{
    "console": "integratedTerminal",
    "env": {
        "SECRET_RESOLVER_SIGNAL_ON_STOP": "TERM+KILL",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

The value is a `+`-separated list of signal steps. Each step can optionally
start with a delay in seconds followed by `:`, then a signal name — `TERM`,
`KILL`, `INT`, or `HUP` (case-insensitive). The first step defaults to no
delay; subsequent steps default to 30 seconds. `"off"` or an empty value
disables signaling, which is the default. Unknown values produce a warning and
fall back to off.

For example: `"TERM"` sends SIGTERM immediately. `"TERM+KILL"` sends SIGTERM
then SIGKILL after 30 s. `"TERM+5:KILL"` uses a 5 s gap instead.
`"INT+10:TERM+KILL"` sends SIGINT, waits 10 s, sends SIGTERM, waits 30 s, then
SIGKILL.

A few things to be aware of: we only signal on Stop, not on detach — if
`terminateDebuggee` is `false` on the DAP `disconnect` request, we do nothing.
We signal the direct children of the `op run` wrapper (the actual program), not
the wrapper itself or the hosting shell. If the program exits on its own before
the next step is due, we cancel the remaining steps. This does not apply to
`internalConsole` launches.

### Extension settings

The only extension setting is `secretResolver.opPath` (default `"op"`): the
path to the 1Password CLI binary. Unqualified names are looked up on `PATH`;
use an absolute path (e.g. `/opt/homebrew/bin/op`) to pin to a specific
install. Changing this setting clears the resolved-secret cache.

## Commands

`Secret Resolver: Clear Cache` drops every cached resolved value and rotates
the in-memory session key. Run this after rotating a vault item if you want the
next launch to fetch a fresh value without reloading the window.

## Requirements

You need the [1Password CLI](https://1password.com/downloads/command-line/)
installed and either signed in (`op signin`) or `OP_SERVICE_ACCOUNT_TOKEN` set
in VS Code's environment. Windows is not supported — we rely on a POSIX shell
environment.

## Security & Privacy

We try to handle secrets carefully, though there are inherent limits to what an
in-process cache can offer.

In `cache` mode, resolved values live in the VS Code extension host process for
the duration of the session. We obfuscate them with HMAC-SHA256 cache keys and
AES-256-GCM values using a per-session random key, and we zero the key buffer
when the cache is cleared or the extension deactivates. This is obfuscation,
not real encryption — the goal is to defeat heap dumps, accidental log
disclosure, and developer-pane inspection, not a determined attacker with code
execution in the extension host.

Be aware that a malicious `launch.json` can reference any vault your signed-in
`op` CLI can reach. The extension declares limited support in untrusted
workspaces for this reason — only enable it in workspaces you control.

For terminal-mode launches the env never touches DAP `arguments.env`. We write
it to a `0600` dotenv file inside a `0700` `mkdtemp` directory under
`os.tmpdir()`. The terminal command line shows the file path (e.g.
`op run --env-file=/tmp/secret-resolver-XXXXXX/env -- <real command>`) but not
the values. We remove the directory when the session ends, and sweep any
crashed-session leftovers on next activation by checking the directory's `.pid`
file against live PIDs. On Linux the file is typically RAM-backed (tmpfs); on
macOS it is disk-resident under `/var/folders/.../T/`.

One gotcha: every terminal-mode launch with a non-empty env is wrapped in
`op run --env-file`, even if it has no `op://` references. That means `op` must
be on `PATH` (or `secretResolver.opPath` must be set) or the launch will fail
to start.

## Limitations

Some debug adapters use a non-map env shape — cppdbg's `environment` array is
the classic example. We cannot process these: our resolver never sees them, and
the tracker has no `arguments.env` to rewrite. Such launches reach the program
with raw `op://` references intact.

## Development

Development requires Node.js 20+ and pnpm 10.33.0. With Corepack enabled,
`pnpm install` picks up the pinned version from `package.json` automatically.
You will also need the 1Password CLI (`op`) for manual testing, `xvfb-run` to
run integration tests on Linux, and the GitHub CLI (`gh`) for publishing.

We pin transitive security fixes in `package.json` `pnpm.overrides` when
upstream packages have not adopted them yet. Keep that list as short as
possible and remove entries once the parent dependency ships the fix.

```bash
pnpm install                                                    # install deps
pnpm exec nx run build                                          # build extension for release (minified)
pnpm exec nx run build:src --configuration=development          # build for development (not minified)
pnpm exec nx run watch                                          # rebuild on file changes (for F5 dev loop)
pnpm exec nx run format           # format:dprint + format:eslint
pnpm exec nx run format:dprint    # dprint fmt
pnpm exec nx run format:eslint    # eslint --fix
pnpm exec nx run check:format     # dprint check
pnpm exec nx run check:lint       # eslint
pnpm exec nx run check:types      # tsc --noEmit
pnpm exec nx run check            # all checks (format + lint + types)
pnpm exec nx run test:unit        # vitest unit tests (no VS Code needed)
pnpm exec nx run test:integration # vscode-test (downloads VS Code on first run)
pnpm exec nx run test             # test:unit + test:integration
pnpm exec nx run stage:check      # format + check + test (pre-push verification)
pnpm exec nx run package          # build .vsix into pkg/
pnpm exec nx run changelog        # regenerate CHANGELOG.md from conventional commits
pnpm exec nx run release:commit   # cut a release (creates commits and tag locally; you still push branch + tag)
pnpm exec nx run ship:github      # upload packaged .vsix as a GitHub release (tag must already exist on GitHub)
pnpm exec nx run ship:marketplace # publish packaged .vsix to VS Code Marketplace
pnpm exec nx run ship:openvsx     # publish packaged .vsix to Open VSX
```

`nx run release:commit` creates the release commit and local tag, then bumps
the release branch to the next patch `-dev` version. When run on `main`, it
also bumps `main` to the next minor `-dev` version. Release refs use `vX.Y.Z`
tags and `vX.Y-dev` branches. The release automation keeps `package.json`
`preview` in sync with the version channel: prerelease and `-dev` versions set
it to `true`, stable releases set it to `false`.

### Publishing

The `ship:*` targets publish the `.vsix` matching the current `package.json`
version from `pkg/`. The order is `release:commit` → `package` → `ship:*`. Each
target needs an auth token:

- `ship:github` needs the release tag already on GitHub, plus either
  `GITHUB_TOKEN` or an active `gh` session
- `ship:marketplace` needs `AZURE_DEVOPS_TOKEN` (Azure DevOps PAT for the
  publisher)
- `ship:openvsx` needs `OPENVSX_TOKEN`

Push the release branch and tag before running `ship:github` — it verifies the
remote tag. Pushing a release tag also triggers the `ship` GitHub workflow
automatically, so manual publishing is only needed for republishes.

## Testing in the Extension Development Host

Press F5 to launch the Extension Development Host, then start a debug session
from `examples/.vscode/launch.json`. For a terminal-mode launch, the terminal
should show
`op run --env-file=/tmp/secret-resolver-XXXXXX/env -- <real command>`, and the
target process should receive resolved values (e.g.
`process.env.DATABASE_URL`). Stop the session and confirm the temp directory
under `os.tmpdir()` is gone. To verify the `opPath` setting, set it to an
absolute path (e.g. `/opt/homebrew/bin/op`) and check that the terminal command
uses it.

## License

MIT
