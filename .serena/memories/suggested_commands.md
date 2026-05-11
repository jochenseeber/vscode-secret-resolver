# Suggested Commands

All build/test/release operations go through `pnpm exec nx run <target>`.

## Daily Development

```bash
pnpm install                                            # install/sync deps
pnpm exec nx run build:src --configuration=development  # dev build (not minified, sourcemaps)
pnpm exec nx run watch                                  # rebuild on file changes (F5 dev loop)
```

## Checks (run before pushing)

```bash
pnpm exec nx run check:types    # tsc --noEmit
pnpm exec nx run check:lint     # eslint
pnpm exec nx run check:format   # dprint check
pnpm exec nx run check          # all three above
```

## Formatting

```bash
pnpm exec nx run format         # dprint + eslint --fix
pnpm exec nx run format:dprint  # dprint fmt only
pnpm exec nx run format:eslint  # eslint --fix only
```

## Testing

```bash
pnpm exec nx run test:unit        # vitest (no VS Code needed; fast)
pnpm exec nx run test:integration # @vscode/test-electron (downloads VS Code on first run)
pnpm exec nx run test             # unit + integration
```

## Pre-push Verification

```bash
pnpm exec nx run stage:check   # format + check + test (full gate)
```

## Release

```bash
pnpm exec nx run changelog        # regenerate CHANGELOG.md
pnpm exec nx run release:commit   # bump version, create commit + local tag
pnpm exec nx run package          # build .vsix into pkg/
pnpm exec nx run ship:github      # upload to GitHub release (tag must exist remotely)
pnpm exec nx run ship:marketplace # publish to VS Code Marketplace (needs AZURE_DEVOPS_TOKEN)
pnpm exec nx run ship:openvsx     # publish to Open VSX (needs OPENVSX_TOKEN)
```

## Manual Testing (Extension Development Host)

Press F5 in VS Code. Launch a debug session from `examples/.vscode/launch.json`.
The terminal should show `op run --env-file=/tmp/secret-resolver-XXXXXX/env -- <cmd>`.
Stop the session; confirm the temp dir under `os.tmpdir()` is cleaned up.

## System Utilities

Standard Darwin tools: `git`, `ls`, `grep`, `find`, `ps`.
Use `uuidgen | tr '[:upper:]' '[:lower:]'` to generate UUIDs (project convention).
