# Project Overview

## Purpose

`vscode-secret-resolver` is a VS Code extension that resolves 1Password `op://`
secret references in debug-launch environment variables. It intercepts VS Code
debug sessions and replaces `op://vault/item/field` references in `env`/`envFile`
with their actual secret values before the debugger starts.

Two resolution modes, selected per-launch via `SECRET_RESOLVER_MODE`:

- **`cache`** (default): runs `op inject` in-extension, caches resolved plaintext
  with AES-256-GCM obfuscation for the session lifetime.
- **`op`**: leaves refs in env; tracker rewrites `runInTerminal` args to
  `op run --env-file=<tmpfile> -- <orig args>` so the 1Password CLI resolves at
  exec time. Requires a terminal console (not `internalConsole`).

Additional per-launch env knobs (all stripped before the debugger sees them):
- `SECRET_RESOLVER_TOKEN_TAG` — vault item tag for a service account token
- `SECRET_RESOLVER_ACCOUNT_ID` — explicit 1Password account shorthand/UUID
- `SECRET_RESOLVER_ACCOUNT_EMAIL` — resolve account from email address
- `SECRET_RESOLVER_ACCOUNT_GIT_CONFIG` — resolve account from git `user.email`
- `SECRET_RESOLVER_SIGNAL_ON_STOP` — signal sequence on debug stop (e.g. `TERM+30:KILL`)

## Tech Stack

- **Language**: TypeScript (strict), targeting Node 20 + VS Code extension host
- **Build**: Vite (bundler), Nx (task orchestration), pnpm (package manager, Corepack-managed)
- **Unit tests**: Vitest (no VS Code host needed; pure module tests in `spec/`)
- **Integration tests**: `@vscode/test-electron` (downloads VS Code; in `test/`)
- **Formatter**: dprint (JSON, Markdown, TypeScript, YAML)
- **Linter**: ESLint
- **Type checker**: `tsc --noEmit`
- **Publisher**: jochenseeber (VS Code Marketplace + Open VSX)
- **Repo**: https://github.com/jochenseeber/vscode-secret-resolver

## No Windows Support (v1)

The factory returns `undefined` on `win32`. All temp-file and signal logic is
POSIX-only.
