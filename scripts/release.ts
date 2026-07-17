#!/usr/bin/env bun
/**
 * release.ts — local release preparation (thin toolchain wrapper).
 *
 * The bump / version-file stamping / CHANGELOG / commit / tag mechanics are
 * owned by @pellux/goodvibes-toolchain `release-cut`, parameterized by this
 * repo's toolchain.config.json (releaseCut section: branch, platform version
 * files, sync commands, commit paths, changelog format). Per the CI/CD design's
 * "CI owns validation" principle, release-cut NEVER re-runs gates — validation
 * happened on the push CI run and is verified by-reference at release time.
 *
 * The one TUI-specific step kept here is deriving the CHANGELOG body from the
 * git log since the last tag; release-cut consumes it via --notes-file.
 *
 * Usage:
 *   bun run scripts/release.ts            # patch bump
 *   bun run scripts/release.ts --minor    # minor bump
 *   bun run scripts/release.ts --major    # major bump
 *   bun run scripts/release.ts --dry-run  # preview without writing
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);

if (args.includes('--major') && args.includes('--minor')) {
  console.error('Error: choose only one of --minor or --major.');
  process.exit(1);
}

const passthrough: string[] = [];
if (args.includes('--major')) passthrough.push('--major');
else if (args.includes('--minor')) passthrough.push('--minor');
if (args.includes('--dry-run')) passthrough.push('--dry-run');

// TUI-specific evidence: derive the CHANGELOG body from the git log since the
// last tag. release-cut turns these lines into the section body.
let log = '';
try {
  log = execSync(
    'git log --oneline $(git describe --tags --abbrev=0 HEAD^)..HEAD 2>/dev/null || git log --oneline -20',
    { cwd: root, encoding: 'utf8' },
  ).trim();
} catch {
  log = '';
}
const bodyLines = log ? log.split('\n').map((line) => `- ${line}`) : ['- See git log for details'];
const notesDir = mkdtempSync(join(tmpdir(), 'gv-release-notes-'));
const notesFile = join(notesDir, 'notes.txt');
writeFileSync(notesFile, `${bodyLines.join('\n')}\n`);

const releaseCutBin = join(root, 'node_modules', '.bin', 'goodvibes-release-cut');
try {
  execFileSync(releaseCutBin, ['--notes-file', notesFile, ...passthrough], { cwd: root, stdio: 'inherit' });
} catch {
  process.exit(1);
}
