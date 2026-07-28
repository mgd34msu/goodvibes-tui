/**
 * typecheck-coverage-rule.ts — gate rule: every TypeScript file the repo tracks
 * must belong to a project that `tsc --noEmit` actually compiles.
 *
 * Why this exists: tsconfig.json used to include only `src` and `examples`, so
 * every file under `scripts/` — including the test runner (scripts/run-tests.ts)
 * and the gate scripts — was never typechecked by either project. Nothing said
 * so; the two typecheck commands both reported 0 errors while 28 files sat
 * outside both programs. Reading the `include` globs is not enough to tell:
 * a file outside every glob is still compiled if something inside a glob imports
 * it (that is how scripts/coverage-gate.ts was covered and scripts/release.ts
 * was not). The only honest answer comes from `tsc --listFilesOnly`, which
 * prints the resolved file list of a real program.
 *
 * Exit code 0 = every tracked file is in a checked program; 1 = it named the
 * files that are not.
 *
 *   Run: bun run scripts/typecheck-coverage-rule.ts
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, derived from this file's location. */
export const REPO_ROOT = join(__dirname, '..');

/** The tsconfig projects whose union must cover every tracked TypeScript file. */
export const CHECKED_PROJECTS: readonly string[] = ['tsconfig.json', 'tsconfig.test.json'];

/** Glob suffixes that make a tracked file "a TypeScript file this gate governs". */
const TS_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * Repo-relative paths that are deliberately outside every project. Each entry
 * needs a reason; an empty list is the healthy state. This is an explicit
 * escape hatch, not a silent one — an unlisted uncovered file fails the gate.
 */
export const UNCOVERED_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

/**
 * Set difference: which tracked files are in none of the checked programs.
 *
 * Pure, so the gate's own test can feed it a path it knows is absent and watch
 * it come back as a violation — a coverage check that can only ever answer
 * "all covered" is worth nothing.
 */
export function findUncoveredFiles(
  trackedFiles: readonly string[],
  coveredFiles: ReadonlySet<string>,
  allowlist: ReadonlySet<string> = UNCOVERED_ALLOWLIST,
): string[] {
  return trackedFiles
    .filter((f) => !coveredFiles.has(f) && !allowlist.has(f))
    .sort();
}

/** True when `path` is a TypeScript source file (by extension). */
export function isTypeScriptPath(path: string): boolean {
  return TS_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Every TypeScript file in the repo, as repo-relative paths.
 *
 * `--others --exclude-standard` includes files that are present but not yet
 * committed, minus anything .gitignore covers. Tracked-only would let a brand
 * new uncovered file pass the gate right up until the commit that adds it — the
 * moment when noticing is worth the most.
 */
export function listTrackedTypeScriptFiles(repoRoot: string = REPO_ROOT): string[] {
  const res = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts', '*.cts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed (status ${String(res.status)}): ${res.stderr ?? ''}`);
  }
  return (res.stdout ?? '')
    .split('\0')
    .filter((line) => line.length > 0 && isTypeScriptPath(line))
    .sort();
}

/**
 * The resolved file list of one tsconfig project, as repo-relative paths.
 *
 * Excludes node_modules (dependency .d.ts files are compiled but are not repo
 * sources) and anything resolving outside the repo root.
 */
export function listProjectFiles(project: string, repoRoot: string = REPO_ROOT): Set<string> {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  const res = spawnSync(tsc, ['-p', project, '--listFilesOnly'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  const lines = (res.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error(
      `tsc --listFilesOnly -p ${project} produced no file list (status ${String(res.status)}): ${res.stderr ?? ''}`,
    );
  }
  const covered = new Set<string>();
  for (const abs of lines) {
    if (abs.includes('/node_modules/')) continue;
    const rel = relative(repoRoot, resolve(repoRoot, abs));
    if (rel.startsWith('..')) continue;
    covered.add(rel);
  }
  return covered;
}

/** Union of the resolved file lists of every checked project. */
export function listCoveredFiles(
  projects: readonly string[] = CHECKED_PROJECTS,
  repoRoot: string = REPO_ROOT,
): Set<string> {
  const covered = new Set<string>();
  for (const project of projects) {
    for (const file of listProjectFiles(project, repoRoot)) covered.add(file);
  }
  return covered;
}

if (import.meta.main) {
  const tracked = listTrackedTypeScriptFiles();
  const covered = listCoveredFiles();
  const uncovered = findUncoveredFiles(tracked, covered);
  if (uncovered.length > 0) {
    console.error(
      `typecheck-coverage: ${uncovered.length} tracked TypeScript file(s) are in no checked project:`,
    );
    for (const f of uncovered) console.error(`  - ${f}`);
    console.error(
      `Add them to the "include" of ${CHECKED_PROJECTS.join(' or ')}, or list them in UNCOVERED_ALLOWLIST with a reason.`,
    );
    process.exit(1);
  }
  console.log(
    `typecheck-coverage: OK — all ${tracked.length} tracked TypeScript file(s) are compiled by ${CHECKED_PROJECTS.join(' + ')}.`,
  );
}
