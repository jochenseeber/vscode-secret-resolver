# Secret Resolver for VS Code

A VS Code extension that routes debug launches through `op run`, so 1Password
secret references (`op://VaultName/ItemID/field`) in launch configuration
environment variables are resolved by the 1Password CLI at process start time.

## Features

- Intercepts `runInTerminal` DAP requests and prepends `op run --` to the
  launch command. Env vars from `env` and `envFile` flow through to `op run`,
  which resolves any `op://` references just before `exec`'ing the real
  command. Plaintext never touches extension memory or disk.
- Configurable `op` binary path (setting: `secretResolver.opPath`, default
  `"op"`, looked up on `PATH` when unqualified).
- Works with any debug adapter that uses `runInTerminal`
  (`console: "integratedTerminal"`) and supports `envFile` natively — Node
  (js-debug), Python, Go, C/C++, Java, etc.

## Requirements

- [1Password CLI](https://1password.com/downloads/command-line/) installed
- Signed in (`op signin`), or 1Password service account token set in
  `OP_SERVICE_ACCOUNT_TOKEN`
- POSIX shell environment. Windows is not supported.

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
            "console": "integratedTerminal",
            "env": {
                "DATABASE_URL": "op://Development/Database/connection-string",
                "API_KEY": "op://Development/API/key"
            },
            "envFile": "${workspaceFolder}/.env"
        }
    ]
}
```

At launch, the debug adapter sends a `runInTerminal` DAP request with the
merged env (inline `env` wins on key conflicts — VS Code's native behavior).
The extension rewrites the request's `args` to prepend
`["op", "run", "--", ...]`. The `op` CLI then inherits the env, resolves every
`op://` reference, and executes the real command with resolved values.

## Configuration

- `secretResolver.opPath` (string, default `"op"`) — path to the 1Password CLI
  binary. Unqualified values are looked up on `PATH`; use an absolute path
  (e.g. `/opt/homebrew/bin/op`) to pin to a specific install.

## Security & Privacy

- **No plaintext in the extension.** The extension never resolves references
  itself and never holds a plaintext secret. `op run` does the resolution in a
  child process that calls the target.
- **Terminal visibility.** For `runInTerminal` launches, the terminal shows
  something like `env KEY=op://vault/item/field … op run -- node app.js`. The
  `op://` references are visible — they're pointers, not secrets. Vault and
  item names leak to anyone reading the terminal; actual credential values do
  not.
- **Workspace trust.** The extension declares limited support in untrusted
  workspaces. A malicious `launch.json` can reference any vault your signed-in
  `op` CLI can read, so only enable this extension in workspaces you control.

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
and `vX.Y-dev` branches.

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
   `env KEY=op://… op run -- <real command>`, and the target process should
   receive resolved env values (e.g. `process.env.DATABASE_URL`).
4. Set `secretResolver.opPath` to an absolute path (e.g.
   `/opt/homebrew/bin/op`) and verify the terminal uses it.

## License

MIT
