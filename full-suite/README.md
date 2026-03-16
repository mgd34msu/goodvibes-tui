# Full Suite Test Project

A test fixture for validating all 12 native tools in goodvibes-tui.

## Structure
- src/ — TypeScript source with intentional issues (dead code, security, circular deps)
- prisma/ — Database schema for inspect tool testing
- styles/ — CSS for layout analysis
- test/ — Test files
- data/ — Sample data files

## Intentional Issues
- src/auth.ts has hardcoded secrets (for security scan testing)
- src/index.ts has an unused export (for dead code testing)
- src/utils.ts <-> src/auth.ts have a circular dependency
- src/components/Button.tsx has accessibility issues (div with onClick, img without alt)
