import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Release script — bumps version, updates CHANGELOG, creates git tag.
 *
 * Defaults to patch bumps. Minor/major require explicit flags.
 *
 * Usage:
 *   bun run scripts/release.ts              # patch bump (0.9.10 → 0.9.11)
 *   bun run scripts/release.ts --minor      # minor bump (0.9.10 → 0.10.0)
 *   bun run scripts/release.ts --major      # major bump (0.9.10 → 1.0.0)
 *   bun run scripts/release.ts --dry-run    # preview without writing
 *
 * What it does:
 *   1. Pre-release validation (typecheck + build + full gate suite)
 *   2. Bump patch version in package.json
 *   3. Update package.json on disk
 *   4. Update src/version.ts fallback via prebuild script
 *   5. Prepend new section to CHANGELOG.md
 *   6. Stage changes, commit, create annotated git tag
 *
 * Flags:
 *   --dry-run        Preview without writing
 *   --skip-validation  Skip typecheck + build (legacy compat)
 *   --skip-gates     Skip full gate suite (loud warning printed; escape hatch only)
 *   --minor          Minor version bump
 *   --major          Major version bump
 */

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_VALIDATION = args.includes('--skip-validation');
const SKIP_GATES = args.includes('--skip-gates');
const bumpMode = args.includes('--major')
  ? 'major'
  : args.includes('--minor')
    ? 'minor'
    : 'patch';

if (args.includes('--major') && args.includes('--minor')) {
  console.error('Error: choose only one of --minor or --major.');
  process.exit(1);
}

const root = process.cwd();

function run(cmd: string, opts: { silent?: boolean } = {}): string {
  if (DRY_RUN && !opts.silent) {
    console.log(`[dry-run] ${cmd}`);
    return '';
  }
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit' });
  } catch (error: unknown) {
    console.error(`\nCommand failed: ${cmd}`);
    if (typeof error === 'object' && error !== null) {
      const commandError = error as { stdout?: string | Uint8Array; stderr?: string | Uint8Array };
      if (commandError.stdout) console.error(String(commandError.stdout));
      if (commandError.stderr) console.error(String(commandError.stderr));
    }
    process.exit(1);
  }
}

function runSilent(cmd: string): string {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return '';
  }
}

// --- Pre-flight checks ---

// Ensure we are on a clean working tree (no uncommitted changes)
const gitStatus = runSilent('git status --porcelain');
if (gitStatus.trim()) {
  console.error('Error: working tree has uncommitted changes. Commit or stash before releasing.');
  console.error(gitStatus);
  process.exit(1);
}

// Ensure we are on main branch
const currentBranch = runSilent('git rev-parse --abbrev-ref HEAD').trim();
if (currentBranch !== 'main') {
  console.error(`Error: releases must be cut from main (current branch: ${currentBranch})`);
  process.exit(1);
}

// --- Read current version ---

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current: string = pkg.version;

// Parse semver
const parts = current.split('.').map(Number);
if (parts.length !== 3 || parts.some(isNaN)) {
  console.error(`Error: cannot parse version '${current}' as semver`);
  process.exit(1);
}

const [major, minor, patch] = parts;

const next = bumpMode === 'major'
  ? `${major + 1}.0.0`
  : bumpMode === 'minor'
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;

console.log(`\nRelease: ${current} → ${next}`);
if (DRY_RUN) console.log('(dry-run mode — no files will be written)\n');

// --- Pre-release validation ---

if (!SKIP_VALIDATION) {
  console.log('\n[1/10] Running typecheck...');
  run('bunx tsc --noEmit');

  console.log('\n[2/10] Running build...');
  run('bun run build');
} else {
  console.log('\n[1/10] Skipping validation (--skip-validation)');
  console.log('[2/10] Skipping build (--skip-validation)');
}

// --- Full gate suite (mirrors what CI demands before merging) ---
//
// A tag must never be cuttable from a tree that has not passed every gate
// CI requires. --skip-gates is an escape hatch for emergencies only.

if (!SKIP_GATES) {
  console.log('\n[3/10] Running tests...');
  run('bun run test');

  console.log('\n[4/10] Running architecture check...');
  run('bun run architecture:check');

  console.log('\n[5/10] Running performance check...');
  run('bun run perf:check');

  console.log('\n[6/10] Running eval gate...');
  run('bun run eval:gate');
} else {
  console.warn(
    '\n' +
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
    '!! WARNING: --skip-gates is active.                             !!\n' +
    '!! The full gate suite (tests, architecture, perf, eval) was    !!\n' +
    '!! NOT run. You are tagging a release that has NOT been         !!\n' +
    '!! validated to the same standard CI requires. This tag may     !!\n' +
    '!! produce a broken release. Only proceed if you are certain    !!\n' +
    '!! CI has already validated this exact commit.                  !!\n' +
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  );
  console.log('[3/10] Skipping tests (--skip-gates)');
  console.log('[4/10] Skipping architecture check (--skip-gates)');
  console.log('[5/10] Skipping performance check (--skip-gates)');
  console.log('[6/10] Skipping eval gate (--skip-gates)');
}

// --- Bump package.json ---

console.log(`\n[7/10] Updating package.json: ${current} → ${next}`);
if (!DRY_RUN) {
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// --- Update src/version.ts via prebuild script ---

console.log('\n[8/10] Syncing src/version.ts via prebuild...');
run('bun run scripts/prebuild.ts');

// --- Update CHANGELOG.md ---

console.log('\n[9/10] Updating CHANGELOG.md...');

const changelogPath = join(root, 'CHANGELOG.md');
const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

const newSection = [
  `## [${next}] — ${today}`,
  '',
  '### Changes',
  ...(() => {
    try {
      const log = execSync('git log --oneline $(git describe --tags --abbrev=0 HEAD^)..HEAD 2>/dev/null || git log --oneline -20', { cwd: root, encoding: 'utf8' }).trim();
      return log ? log.split('\n').map((line: string) => `- ${line}`) : ['- See git log for details'];
    } catch {
      return ['- See git log for details'];
    }
  })(),
  '',
].join('\n');

if (!DRY_RUN) {
  let changelog = readFileSync(changelogPath, 'utf8');

  // Insert new section after the first "---" separator
  const insertMarker = '---';
  const markerIdx = changelog.indexOf(insertMarker);
  if (markerIdx === -1) {
    console.error('Error: could not find --- separator in CHANGELOG.md');
    process.exit(1);
  }

  const afterMarker = markerIdx + insertMarker.length;
  changelog =
    changelog.slice(0, afterMarker) +
    '\n\n' +
    newSection +
    changelog.slice(afterMarker).replace(/^\n+/, '\n');

  writeFileSync(changelogPath, changelog);
  console.log(`CHANGELOG.md: prepended section for ${next}`);
} else {
  console.log('[dry-run] Would prepend to CHANGELOG.md:');
  console.log(newSection);
}

// --- Git commit + tag ---

console.log(`\n[10/10] Creating git commit and tag v${next}...`);

const tag = `v${next}`;
const commitMsg = `chore: release ${tag}`;

run('git add package.json src/version.ts README.md CHANGELOG.md docs/foundation-artifacts');
run(`git commit -m "${commitMsg}"`);
run(`git tag -a ${tag} -m "Release ${tag}"`);

console.log(`\nRelease ${tag} complete.`);
console.log('Next step: git push && git push --tags');
