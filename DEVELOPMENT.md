# Development

Development requires Node.js 22+ (the `@vscode/test-cli` /
`@vscode/test-electron` toolchain declares `engines.node >= 22`) and pnpm
10.33.0. With Corepack enabled, `pnpm install` picks up the pinned version from
`package.json` automatically. You will also need the 1Password CLI (`op`) for
manual testing, `xvfb-run` to run integration tests on Linux, and the GitHub
CLI (`gh`) for publishing.

We pin transitive security fixes in the `overrides` section of
`pnpm-workspace.yaml` when upstream packages have not adopted them yet. Keep
that list as short as possible and remove entries once the parent dependency
ships the fix.

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

## Publishing

The `ship:*` targets publish the `.vsix` matching the current `package.json`
version from `pkg/`. The order is `release:commit` -> `package` -> `ship:*`.
Each target needs an auth token:

- `ship:github` needs the release tag already on GitHub, plus either
  `GITHUB_TOKEN` or an active `gh` session
- `ship:marketplace` needs `AZURE_DEVOPS_TOKEN` (Azure DevOps PAT for the
  publisher)
- `ship:openvsx` needs `OPENVSX_TOKEN`

Push the release branch and tag before running `ship:github` - it verifies the
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
