# Full Suite Test Project

A test fixture for validating all 12 native tools in goodvibes-tui.

## Structure
- `src/` — TypeScript source with intentional issues (dead code, security, circular deps)
- `prisma/` — Database schema for inspect tool testing
- `styles/` — CSS for layout analysis
- `test/` — Test files
- `data/` — Sample data files
- `modules/` — Modular test suite (run each independently)

## Intentional Issues
- `src/auth.ts` has hardcoded secrets (for security scan testing)
- `src/index.ts` has an unused export (for dead code testing)
- `src/utils.ts` <-> `src/auth.ts` have a circular dependency
- `src/components/Button.tsx` has accessibility issues (div with onClick, img without alt)

## Test Suite (Modular)

See [TEST-INSTRUCTIONS.md](TEST-INSTRUCTIONS.md) for the full module index.

Run each module separately to avoid rate limits and timeouts.

| Module | Tool | Tests | Description |
|--------|------|-------|-------------|
| [01-read.md](modules/01-read.md) | read | 7 | File reading, extract modes, cache |
| [02-find.md](modules/02-find.md) | find | 8 | File/content/symbol discovery |
| [03-analyze.md](modules/03-analyze.md) | analyze | 6 | Deps, dead code, security, preview |
| [04-inspect.md](modules/04-inspect.md) | inspect | 5 | Project, DB, components, a11y, scaffold |
| [05-registry.md](modules/05-registry.md) | registry | 4 | Tool listing, schema, search |
| [06-write.md](modules/06-write.md) | write | 5 | Create, overwrite, base64, dry_run |
| [07-edit.md](modules/07-edit.md) | edit | 6 | Exact, regex, fuzzy, atomic, dry_run |
| [08-exec.md](modules/08-exec.md) | exec | 5 | Shell commands, expectations |
| [09-state.md](modules/09-state.md) | state | 5 | In-memory key/value store |
| [10-workflow.md](modules/10-workflow.md) | workflow | 5 | WRFC lifecycle, triggers |
| [11-agent.md](modules/11-agent.md) | agent | 4 | Spawn, status, templates, cancel |
| [12-fetch.md](modules/12-fetch.md) | fetch | 4 | GET, POST, extract, batch |

Total: 58 tests across 12 modules
