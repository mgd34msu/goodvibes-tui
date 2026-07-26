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
 * The one TUI-specific step kept here is producing the CHANGELOG body that
 * release-cut consumes via --notes-file.
 *
 * Product notes come from GOODVIBES_TUI_RELEASE_NOTES, which holds the NOTES
 * THEMSELVES — one release note per line — never a path to a file containing
 * them. A path in that variable would be written into the CHANGELOG verbatim as
 * the release's only note, which is how a scratchpad path once reached a
 * shipped changelog. Same shape as goodvibes-agent's
 * GOODVIBES_AGENT_RELEASE_NOTES, and the same rejection of raw commit-hash
 * lines, so neither repo can ship a commit log in place of product notes.
 *
 * With the variable unset the body falls back to the git log since the last
 * tag. That fallback is for a local dry-run; a real release should set the
 * variable, because a reader of the CHANGELOG cannot use commit subjects.
 *
 * Usage:
 *   bun run scripts/release.ts            # patch bump
 *   bun run scripts/release.ts --minor    # minor bump
 *   bun run scripts/release.ts --major    # major bump
 *   bun run scripts/release.ts --dry-run  # preview without writing
 *
 *   GOODVIBES_TUI_RELEASE_NOTES="$(cat <<'EOF'
 *   Added: ...
 *   Fixed: ...
 *   EOF
 *   )" bun run scripts/release.ts --minor
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

/** Split note CONTENT into changelog bullets, refusing a commit log. */
function bulletsFromNotesContent(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith('- ') ? line : `- ${line}`));
  if (lines.some((line) => /^- [0-9a-f]{7,40}\s/i.test(line))) {
    console.error('Error: release notes must describe product changes, not raw commit hashes.');
    process.exit(1);
  }
  return lines;
}

/** Fallback evidence: the git log since the last tag, for dry runs only. */
function bulletsFromGitLog(): string[] {
  let log = '';
  try {
    log = execSync(
      'git log --oneline $(git describe --tags --abbrev=0 HEAD^)..HEAD 2>/dev/null || git log --oneline -20',
      { cwd: root, encoding: 'utf8' },
    ).trim();
  } catch {
    log = '';
  }
  return log ? log.split('\n').map((line) => `- ${line}`) : ['- See git log for details'];
}

// The variable carries the notes themselves, not a path to them.
const notesContent = process.env.GOODVIBES_TUI_RELEASE_NOTES;
if (notesContent !== undefined && notesContent.trim().length === 0) {
  console.error('Error: GOODVIBES_TUI_RELEASE_NOTES is set but empty. Unset it, or give it the release notes.');
  process.exit(1);
}
const bodyLines = notesContent ? bulletsFromNotesContent(notesContent) : bulletsFromGitLog();
if (!notesContent) {
  console.warn('[release] GOODVIBES_TUI_RELEASE_NOTES not set — falling back to the git log for the CHANGELOG body.');
}
const notesDir = mkdtempSync(join(tmpdir(), 'gv-release-notes-'));
const notesFile = join(notesDir, 'notes.txt');
writeFileSync(notesFile, `${bodyLines.join('\n')}\n`);

const releaseCutBin = join(root, 'node_modules', '.bin', 'goodvibes-release-cut');
try {
  execFileSync(releaseCutBin, ['--notes-file', notesFile, ...passthrough], { cwd: root, stdio: 'inherit' });
} catch {
  process.exit(1);
}
