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

Account selection, the service-account token tag, and the stop-signal sequence
can also be set once, for all launches, through VS Code settings (see
[Extension settings](#extension-settings)). The env var always wins when both
are present — an explicit env var overrides the matching setting, and an
explicitly empty env var switches the setting off.

### How secrets are resolved

Every `op://` reference is resolved in-process by running `op inject`. The
resolved plaintext is cached (obfuscated in memory) for the rest of the VS Code
session. Cached values are scoped to the 1Password account and service-account
token tag they were resolved under, so two launches pinned to different
accounts that reference the same `op://` path each get their own resolution.
This happens inside a proper `DebugConfigurationProvider`, so no API contract
is violated.

For terminal consoles (`integratedTerminal` / `externalTerminal`), VSCode would
otherwise print the resolved `env` — secrets included — on the command line. To
avoid that, the tracker writes the env to a temporary dotenv file (mode `0600`
inside an `0700` directory under the system temp dir) and rewrites the launch
to:

```text
op run --env-file=<tempfile> -- <orig args>
```

so `op run` loads the env as a pass-through and the values never appear on the
command line. The env file holds every env var from the launch configuration —
including ones the debug adapter does not forward to the terminal itself —
merged with the adapter-provided entries (the adapter wins on clashes, e.g. an
extended `NODE_OPTIONS`). We do this through VSCode's tracker API, which is
documented as observation-only but happens to allow command rewriting — so we
(ab)use it. Worst case, if VSCode rejects the rewrite, the launch still
proceeds with the env visible. Note that since the secrets are already
resolved, `op run` cannot mask them in your program's own output: if your app
prints a secret, it shows on the console.

The temp file is removed when the debug session ends; crashed-session leftovers
are swept on the next activation.

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

When the launch contains `op://` references to resolve, we run
`op item list --tags dev-secrets --categories "API Credential"`, fetch the
`credential` field, and use the value as `OP_SERVICE_ACCOUNT_TOKEN` for every
`op` call during this launch. Launches with the token tag but no `op://`
references skip this lookup. The resolved token is cached for the VS Code
session; run `Secret Resolver: Clear Cache` if you need a fresh one.

The token is handed to the in-process `op inject` call via its child
environment (as `OP_SERVICE_ACCOUNT_TOKEN`) — never on the command line. It
never leaves the extension; only the already-resolved plaintext is written to
the temp env file for terminal launches.

### Account selection

If you have multiple 1Password accounts, you can pin a launch to one of them.
We support three ways to do this, checked in priority order: by the git
identity of a project subdirectory, by email address, and by a literal account
ID. Once resolved, the account is passed as `--account <id>` to every `op` call
for the launch (item lookup, `op inject`, and `op run`).

`SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` (highest priority) specifies a relative
subdirectory path where we read `user.email` from its `.git/config`, then look
up the matching account. Use `.` for the workspace root, or leave it empty (or
omit the var entirely) to disable this lookup:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_GIT_CONFIG": "packages/api",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

`SECRET_RESOLVER_ACCOUNT_EMAIL` looks the account up from an email address. We
run `op account list --format json` and match by email (case-insensitive), then
cache the email → UUID result in `SecretCache` so we only call
`op account list` once per session:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_EMAIL": "user@company.com",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

`SECRET_RESOLVER_ACCOUNT_ID` (lowest priority) is the most direct — give us the
account shorthand or UUID and we use it as-is for `--account`:

```json
{
    "env": {
        "SECRET_RESOLVER_ACCOUNT_ID": "SOME_ACCOUNT_ID",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

For the git-config lookup we re-read `user.email` from git on every launch — it
is not cached. We do cache the resolved email → UUID mapping in `SecretCache`
for the session; it is cleared by `Secret Resolver: Clear Cache` and on
extension start/stop.

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
We signal every process in the launched process tree — the `op run` wrapper,
your program, and anything they spawned — except the hosting terminal shell at
the root, which is left alive. Each step re-walks the tree, so processes forked
between steps are still caught. If the program exits on its own before the next
step is due, we cancel the remaining steps. This does not apply to
`internalConsole` launches.

For `integratedTerminal` the launched process is found via the shell PID that
VS Code reports. For `externalTerminal` VS Code reports no PID, so the
extension locates the `op run` wrapper by its unique per-launch command line
(via `pgrep`) and signals that process tree instead. If neither works, a
warning is shown and nothing is signaled.

### Extension settings

- `secretResolver.opPath` (default `"op"`): the path to the 1Password CLI
  binary. Unqualified names are looked up on `PATH`; use an absolute path (e.g.
  `/opt/homebrew/bin/op`) to pin to a specific install. Changing this setting
  clears the resolved-secret cache.
- `secretResolver.accountGitConfig`, `secretResolver.accountEmail`,
  `secretResolver.accountId`: defaults for
  [account selection](#account-selection), mirroring the matching
  `SECRET_RESOLVER_ACCOUNT_*` env vars and honouring the same git-config >
  email > id priority.
- `secretResolver.tokenTag`: a default for the
  [service account token](#service-account-token-secret_resolver_token_tag)
  tag, mirroring `SECRET_RESOLVER_TOKEN_TAG`.
- `secretResolver.signalOnStop`: a default
  [stop-signal sequence](#signal-on-stop-secret_resolver_signal_on_stop),
  mirroring `SECRET_RESOLVER_SIGNAL_ON_STOP`.

These five settings have `resource` scope, so you can set them in user,
workspace, or per-folder (project) settings; the most specific one wins, as
usual for VS Code settings. For a given launch the corresponding
`SECRET_RESOLVER_*` env var still overrides the resolved setting; an explicitly
empty env var switches the setting off for that launch. Leave a setting empty
to disable it.

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

Resolved values live in the VS Code extension host process for the duration of
the session. We obfuscate them with HMAC-SHA256 cache keys and AES-256-GCM
values using a per-session random key, and we zero the key buffer when the
cache is cleared or the extension deactivates. This is obfuscation, not real
encryption — the goal is to defeat heap dumps, accidental log disclosure, and
developer-pane inspection, not a determined attacker with code execution in the
extension host.

Be aware that a malicious `launch.json` can reference any vault your signed-in
`op` CLI can reach. The extension declares limited support in untrusted
workspaces for this reason — only enable it in workspaces you control. In an
untrusted workspace the resolver refuses to resolve a launch environment
outright: the launch is aborted with an error instead of resolving secrets.

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

Development, testing, and publishing notes for contributors live in
[DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MIT](LICENSE.txt)
