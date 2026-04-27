# Secret Resolver for VS Code

A VS Code extension that resolves 1Password secret references
(`op://VaultName/ItemID/field`) in debug-launch environment variables.

## Usage

Reference secrets in `env` and/or `envFile` in your `launch.json`:

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

Before the debug adapter receives the launch, the extension parses any
`envFile` and merges it with the inline `env` (inline wins on conflicts). There
are two resolution modes which work as follows:

- **`op` mode** — `op://` references are left in the env as-is. The tracker
  writes the merged env to a `0600` temp dotenv file and rewrites the spawn
  args to `op run --env-file=<file> -- <orig args>`. The 1Password CLI resolves
  the references at exec time. This mode is supported for `console` settings
  `integratedTerminal` and `externalTerminal`.
- **`cache` mode** — `op://` references are collected, `op inject` is invoked
  once for the missing ones, and resolved plaintext is cached in-memory for the
  session. For terminal consoles the tracker still writes the resolved env to a
  temp file and wraps the launch in `op run --env-file`; `op run` finds no refs
  and acts as a pass-through env loader. For `internalConsole` the adapter
  receives the resolved plaintext directly via `config.env`. This mode is
  supported for all `console` types.

### Switching modes per launch

Set `SECRET_RESOLVER_MODE` in the launch's `env` to override the default:

```json
{
    "console": "integratedTerminal",
    "env": {
        "SECRET_RESOLVER_MODE": "cache",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

The flag itself is stripped before the program runs. Recognized values are
`"op"` and `"cache"`, case-insensitive after trimming. When unset (or set to an
unknown value, which also emits a warning to the extension host console) the
default is console-derived: `"cache"` for `console: "internalConsole"` and
`"op"` otherwise.

### Signaling the program when the user clicks Stop

For `integratedTerminal` and `externalTerminal` launches the debug adapter
typically just detaches when the user clicks Stop — the spawned program keeps
running in the terminal. A per-launch env var makes the extension itself signal
the program in that case:

Set `SECRET_RESOLVER_SIGNAL_ON_STOP` to a `+`-separated sequence of signal
steps. Each step is an optional decimal delay in seconds followed by `:`, then
a signal name (`TERM`, `KILL`, `INT`, `HUP`; case-insensitive). When the delay
is omitted it defaults to **0** for the first step and **30 s** for each
subsequent step. `"off"` or empty disables signaling (default). Unknown or
unparsable values warn and fall back to off.

Examples: `"TERM"` (SIGTERM immediately), `"TERM+KILL"` (SIGTERM, then SIGKILL
after 30 s), `"TERM+5:KILL"` (SIGTERM, then SIGKILL after 5 s),
`"INT+10:TERM+KILL"` (SIGINT, wait 10 s, SIGTERM, wait 30 s, SIGKILL).

```json
{
    "console": "integratedTerminal",
    "env": {
        "SECRET_RESOLVER_SIGNAL_ON_STOP": "TERM+KILL",
        "DATABASE_URL": "op://Development/Database/connection-string"
    }
}
```

Notes:

- Only Stop signals; detach (`terminateDebuggee: false` on the DAP `disconnect`
  request) never signals.
- If the program exits naturally before the next step in the sequence is due,
  no further signal is sent.
- Terminal modes only — the tracker walks the process tree from the spawned
  shell PID, locates the `op run` wrapper(s), and signals only their direct
  children (the actual program). The `op run` wrapper and the hosting shell are
  left alone and exit naturally when their child does.
- `internalConsole` is not affected; the debug adapter terminates it cleanly.
- The flag is stripped from the program's env before launch.

## Configuration

- `secretResolver.opPath` (string, default `"op"`) — path to the 1Password CLI
  binary. Unqualified values are looked up on `PATH`; use an absolute path
  (e.g. `/opt/homebrew/bin/op`) to pin to a specific install. Changing this
  setting clears the resolved-secret cache.

## Commands

- `Secret Resolver: Clear Cache` — drops every cached resolved value and
  rotates the in-memory session key. Use after rotating a vault item if you
  want the next launch to fetch a fresh value without reloading the window.

## Requirements

- [1Password CLI](https://1password.com/downloads/command-line/) installed
- Signed in (`op signin`), or 1Password service account token set in
  `OP_SERVICE_ACCOUNT_TOKEN`
- POSIX shell environment. Windows is not supported.

## Security & Privacy

- **In-memory cache, not encrypted at rest.** Resolved values live only in the
  extension host process for the duration of the VS Code session. The cache
  uses HMAC-SHA256 keys and AES-256-GCM values with a per-session random key;
  this is obfuscation, not real encryption — the goal is to defeat heap dumps,
  accidental log disclosure, and developer-pane inspection, not a determined
  attacker with code execution in the extension host. The session key is held
  in a `Buffer` that is zeroed on clear/deactivate.
- **Workspace trust.** The extension declares limited support in untrusted
  workspaces. A malicious `launch.json` can reference any vault your signed-in
  `op` CLI can read, so only enable this extension in workspaces you control.
- **Terminal-mode env file.** The launch env lands in a `0600` dotenv file
  inside an `0700` `mkdtemp` dir under `os.tmpdir()`. The terminal command line
  shows the file path (e.g.
  `op run --env-file=/tmp/secret-resolver-XXXXXX/env -- <real command>`) but
  not the env values themselves. Plaintext / `op://` references stay inside the
  file. The dir is removed on session end; crashed-session leftovers are swept
  on next activation by checking the dir's `.pid` file against live PIDs. On
  Linux distros where `os.tmpdir()` is tmpfs (most systemd defaults), the file
  is RAM-backed; on macOS it is disk-resident under `/var/folders/.../T/`.
- **`op` CLI is required for every terminal-mode launch with non-empty env** —
  even those that have no `op://` references — because the launch is always
  wrapped in `op run --env-file`. Without `op` on `PATH` (or
  `secretResolver.opPath` set) such launches will fail to start.

## Limitations

- Adapters that use a non-map env shape (e.g. cppdbg's `environment` array) are
  not processed by the in-extension resolver, and the tracker has no
  `arguments.env` to wrap. Such launches reach the program with raw `op://`
  references intact.

## Development

Development expects Node.js 20+ and pnpm 10.33.0. With Corepack enabled,
`pnpm install` will use the pinned package manager version from `package.json`.

Required tools for local development:

- Node.js 20+
- pnpm 10.33.0 (or Corepack)
- 1Password CLI (`op`)
- `xvfb-run` for running the integration tests
- `git` for the release script
- Github CLI (`gh`) for publishing

Transitive security fixes that upstream packages have not adopted yet are
pinned at the workspace root via `package.json` `pnpm.overrides`. Keep that
list as small as possible and remove entries once the parent dependency catches
up.

```bash
pnpm install               # install deps
pnpm run compile           # tsc once
pnpm run watch             # tsc in watch mode
pnpm run format            # format:dprint + format:eslint
pnpm run format:dprint     # dprint fmt
pnpm run format:eslint     # eslint --fix
pnpm run check:format      # dprint check
pnpm run check:lint        # eslint
pnpm run test:unit         # mocha unit tests (no VS Code needed)
pnpm run test:integration  # vscode-test (downloads VS Code on first run)
pnpm run test              # test:unit + test:integration
pnpm run verify            # compile + check:lint + check:format + test
pnpm run package           # build .vsix into pkg/
pnpm run changelog         # regenerate CHANGELOG.md from conventional commits
pnpm run release           # cut a release (creates the tag locally; you still push branch + tag)
pnpm run ship:github       # upload packaged .vsix as a GitHub release (tag must already exist on GitHub)
pnpm run ship:marketplace  # publish packaged .vsix to VS Code Marketplace
pnpm run ship:openvsx      # publish packaged .vsix to Open VSX
pnpm run ship              # ship:github + ship:marketplace + ship:openvsx
```

`pnpm run release` creates the release commit and local tag first, then bumps
the release branch to the next patch `-dev` version. When run on `main`, it
also bumps `main` to the next `-dev` version. Release refs use `vX.Y.Z` tags
and `vX.Y-dev` branches. The release automation also keeps `package.json`
`preview` aligned with the version channel: prerelease and `-dev` versions set
it to `true`, stable releases set it to `false`.

### Publishing

The `ship:*` scripts publish the `.vsix` matching the current `package.json`
version from `pkg/`. Order of operations: `release` → `package` → `ship*`. Each
script reads its auth from an environment variable:

- `ship:github` requires the release tag to already exist on GitHub, plus
  either `GITHUB_TOKEN` or a gh CLI session that is already logged in
- `ship:marketplace` requires `AZURE_DEVOPS_TOKEN` (Azure DevOps PAT for the
  publisher)
- `ship:openvsx` requires `OPENVSX_TOKEN`

If you run `ship:github` or `ship` manually, push the release branch and tag
first so the GitHub release step can verify the remote tag before publishing.

Pushing a release tag triggers the `ship` GitHub workflow, which runs
`pnpm run package` followed by the three `ship:*` scripts, so these commands
are only needed for manual republishes.

## Testing in the Extension Development Host

1. Press F5 in VS Code to launch the Extension Development Host.
2. Create a test launch configuration with `op://` references in `env` and/or
   `envFile`, and `console: "integratedTerminal"`.
3. Start the debug session. The terminal should show
   `op run --env-file=/tmp/secret-resolver-XXXXXX/env -- <real command>`, and
   the target process should receive resolved env values (e.g.
   `process.env.DATABASE_URL`).
4. Stop the session and confirm the temp dir under `os.tmpdir()` is gone.
5. Set `secretResolver.opPath` to an absolute path (e.g.
   `/opt/homebrew/bin/op`) and verify the terminal uses it.

## License

MIT
