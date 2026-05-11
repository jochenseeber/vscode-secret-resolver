# Task Completion Checklist

When a coding task is complete, run these in order:

## 1. Type Check (always)

```bash
pnpm exec nx run check:types
```

Fix all type errors before proceeding.

## 2. Unit Tests (always)

```bash
pnpm exec nx run test:unit
```

Unit tests live in `spec/` and cover all pure modules. They inject fakes for
all I/O — no real `op` CLI or filesystem access required.

## 3. Format (if files were modified)

```bash
pnpm exec nx run format
```

This runs dprint + eslint --fix. Commit the formatted output.

## 4. Spell Check (if new words were added)

```bash
pnpm exec cspell --no-progress "src/**/*.ts" "spec/**/*.ts"
```

Add unknown correctly-spelled words to `cspell.dict` (lowercase singular,
alphabetical). Suppress on test-data lines with `// cspell:disable-line`.

## 5. Lint (before push)

```bash
pnpm exec nx run check:lint
```

## 6. Full Stage Check (before push)

```bash
pnpm exec nx run stage:check
```

This runs format + all checks + unit + integration tests.

## Notes

- Integration tests require VS Code to be downloaded on first run (`nx run test:integration`)
- For substantial changes: prefer `nx run stage:check` before closing out
- Do NOT commit unless the user explicitly asks for it
- Use `git commit -am "Checkpoint"` for checkpoint commits when asked
- `AGENTS.md` is the AI-facing doc; `README.md` is the human-facing doc — keep both updated and non-redundant
