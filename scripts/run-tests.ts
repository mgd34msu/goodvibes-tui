import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative } from 'node:path';
import { filterTestFilesByPattern, parseTestPattern } from './test-pattern-rule.ts';
import { sweepStaleTestTmp } from './stale-tmp-sweep.ts';

const ROOT = process.cwd();
const SEARCH_ROOT = join(ROOT, 'src');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
// Shared root for all test-tmp artifacts.
const TEST_TMP_ROOT = join(ROOT, '.test-tmp');
// Runner-unique subdir: each concurrent runner owns only its own subtree.
// This prevents cross-process wipes when multiple bun test processes run in
// parallel (e.g., concurrent agent chains). Only this runner's subdir is
// created/deleted; sibling runners are never touched.
const RUNNER_DIR = join(TEST_TMP_ROOT, `run-${process.pid}`);

// Pass --coverage through to bun test when invoked with that flag.
const COVERAGE = process.argv.includes('--coverage');

// Optional positional pattern filter (first non-flag argv token), e.g. the TUI's
// /test <pattern> passthrough. Matched as a substring against each test file's
// path relative to ROOT, so both a bare filename fragment ("diff-runtime") and a
// directory-scoped pattern ("src/test/input") work. Logic lives in
// test-pattern-rule.ts so it can be unit tested without running the full suite.
const PATTERN = parseTestPattern(process.argv.slice(2));

// Per-file worker pool size. The per-file process isolation (one bun test
// process per file, each with its own TMPDIR) is the point of this runner;
// running the files N at a time just stops paying 600+ sequential process
// startups (this took the CI test job past its budget). Override with
// --jobs N or GOODVIBES_TEST_JOBS; capped to keep peak memory sane.
const JOBS = (() => {
  const flagIdx = process.argv.indexOf('--jobs');
  if (flagIdx !== -1) {
    const n = Number(process.argv[flagIdx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const env = Number(process.env.GOODVIBES_TEST_JOBS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return Math.max(1, Math.min(8, availableParallelism() - 1));
})();

// Per-test ceiling. bun's built-in default is 5 000 ms, and that is an idle
// machine's number: this runner deliberately runs JOBS test files at once, many
// of them boot a real daemon, open a real socket, compile a sql.js WASM module,
// or shell out to git — work whose wall-clock cost is set by how busy the host
// is, not by what the test asserts. Measured on this project's own machine
// under a realistic concurrent load, src/test/state/memory-store.test.ts took
// 103.65 s for 38 tests and several daemon-backed files failed outright with
// "this test timed out after 5000ms" while the daemon was still coming up
// normally.
//
// This is a CEILING, not a delay: nothing waits it out, so a fast host finishes
// exactly as quickly as before and only a genuinely stuck test pays it. A test
// that needs a different budget still declares its own as the third argument to
// test(), which continues to win over this default.
const TIMEOUT_MS = (() => {
  const flagIdx = process.argv.indexOf('--timeout');
  if (flagIdx !== -1) {
    const n = Number(process.argv[flagIdx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const env = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return 60_000;
})();

// Age-based sweep at startup (see scripts/stale-tmp-sweep.ts): remove stale
// entries older than 1 h under .test-tmp — both leftover run-* runner subtrees
// AND makeProjectTempDir leftovers (<prefix>-<random>) that a signal-killed test
// process's exit hook never cleaned. Replaces the previous full-root wipe and is
// safe under concurrency: a live sibling's dirs were created moments ago and are
// never 1 h old.

function collectTests(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTests(fullPath, acc);
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      acc.push(fullPath);
    }
  }
}

const allTestFiles: string[] = [];
collectTests(SEARCH_ROOT, allTestFiles);
allTestFiles.sort((a, b) => a.localeCompare(b));
const testFiles = filterTestFilesByPattern(allTestFiles, ROOT, PATTERN);

// Sweep stale sibling entries (older than 1 h), then create this runner's own
// subdir. Sibling runners still in progress are untouched by the sweep.
sweepStaleTestTmp(TEST_TMP_ROOT);
rmSync(RUNNER_DIR, { recursive: true, force: true });
mkdirSync(RUNNER_DIR, { recursive: true });

if (testFiles.length === 0) {
  console.error(PATTERN ? `No test files matched pattern: ${PATTERN}` : 'No test files found under src/');
  process.exit(1);
}

let passedFiles = 0;
let failedFiles = 0;

/**
 * Run one test file in its own bun process with an isolated TMPDIR
 * (identical isolation semantics to the previous sequential runner).
 * Output is buffered and printed on completion so parallel files never
 * interleave mid-line.
 */
async function runFile(testFile: string): Promise<void> {
  const rel = relative(ROOT, testFile);
  // Unique per-file tmp subdir keeps TMPDIR-rooted artifacts isolated.
  // Scoped under RUNNER_DIR so concurrent runners never collide.
  const testTmpDir = join(
    RUNNER_DIR,
    rel.replace(/[^a-z0-9_.-]+/gi, '-'),
  );
  rmSync(testTmpDir, { recursive: true, force: true });
  mkdirSync(testTmpDir, { recursive: true });
  // try/finally so the per-file tmp dir is removed on EVERY exit path — not just
  // a clean run or a non-zero test exit (both of which reach the end normally),
  // but also an exception thrown by Bun.spawn or the stdout/stderr reads. Under
  // these worktrees the project lives on /tmp, so a leaked per-file dir is a
  // leaked /tmp inode subtree; the finally keeps the leak from surviving a
  // crash-mid-file until the 1 h stale sweep.
  try {
    const bunArgs = ['bun', 'test', `--timeout=${TIMEOUT_MS}`];
    if (COVERAGE) bunArgs.push('--coverage');
    bunArgs.push(testFile);
    const proc = Bun.spawn(bunArgs, {
      cwd: ROOT,
      env: {
        ...process.env,
        TMPDIR: testTmpDir,
        TMP: testTmpDir,
        TEMP: testTmpDir,
        // TMPDIR is redirected *inside* this project's own repo, so a bare temp dir
        // created by a test sits under the project `.git` and git discovery walks up
        // and finds it — breaking any test that needs a genuinely non-git directory.
        // Fence discovery at the per-file temp root so git stops before the project
        // repo. (Set here in the child's spawn env because Bun snapshots the
        // environment at process start — a late process.env mutation inside a test
        // would not reach GitService.isGitRepo's inherited Bun.spawnSync.) Temp repos
        // a test `git init`s under this dir are unaffected: their own `.git` is found
        // before discovery reaches the ceiling.
        GIT_CEILING_DIRECTORIES: testTmpDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const ok = exitCode === 0;
    const output = (stdout + stderr).trimEnd();
    console.log(`\n==> ${rel}${ok ? '' : '  [FAIL]'}`);
    if (output) console.log(output);

    if (ok) passedFiles += 1;
    else failedFiles += 1;
  } finally {
    rmSync(testTmpDir, { recursive: true, force: true });
  }
}

let nextFileIndex = 0;
async function worker(): Promise<void> {
  while (true) {
    const i = nextFileIndex++;
    if (i >= testFiles.length) return;
    await runFile(testFiles[i]!);
  }
}

console.log(`Running ${testFiles.length} test files with ${JOBS} parallel job${JOBS === 1 ? '' : 's'}${PATTERN ? ` (pattern: ${PATTERN})` : ''}.`);
try {
  await Promise.all(Array.from({ length: Math.min(JOBS, testFiles.length) }, () => worker()));
} finally {
  // Remove this runner's own subdir on every exit path (including a worker
  // exception), so a crashed run never leaks its whole run-<pid> subtree.
  // Sibling runners are untouched.
  rmSync(RUNNER_DIR, { recursive: true, force: true });
}

console.log(`\nTest files: ${testFiles.length}, passed: ${passedFiles}, failed: ${failedFiles}`);
process.exit(failedFiles === 0 ? 0 : 1);
