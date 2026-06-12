import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

// Age-based sweep: remove stale run-* dirs older than 1 hour at startup.
// This replaces the previous full-root wipe and is safe under concurrency:
// a running sibling's dir was created moments ago and will never be 1 h old.
const STALE_MS = 60 * 60 * 1000; // 1 hour
function sweepStaleRunnerDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(TEST_TMP_ROOT);
  } catch {
    return; // root doesn't exist yet — nothing to sweep
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('run-')) continue;
    const full = join(TEST_TMP_ROOT, name);
    try {
      const st = statSync(full);
      if (now - st.mtimeMs > STALE_MS) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore — another process may have already removed it
    }
  }
}

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

const testFiles: string[] = [];
collectTests(SEARCH_ROOT, testFiles);
testFiles.sort((a, b) => a.localeCompare(b));

// Sweep stale sibling runner dirs (older than 1 h), then create this runner's
// own subdir. Sibling runners still in progress are untouched by the sweep.
sweepStaleRunnerDirs();
rmSync(RUNNER_DIR, { recursive: true, force: true });
mkdirSync(RUNNER_DIR, { recursive: true });

if (testFiles.length === 0) {
  console.error('No test files found under src/');
  process.exit(1);
}

let passedFiles = 0;
let failedFiles = 0;

for (const testFile of testFiles) {
  const rel = relative(ROOT, testFile);
  // Unique per-file tmp subdir keeps TMPDIR-rooted artifacts isolated.
  // Scoped under RUNNER_DIR so concurrent runners never collide.
  const testTmpDir = join(
    RUNNER_DIR,
    rel.replace(/[^a-z0-9_.-]+/gi, '-'),
  );
  rmSync(testTmpDir, { recursive: true, force: true });
  mkdirSync(testTmpDir, { recursive: true });
  console.log(`\n==> ${rel}`);
  const bunArgs = ['bun', 'test'];
  if (COVERAGE) bunArgs.push('--coverage');
  bunArgs.push(testFile);
  const result = Bun.spawnSync(bunArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      TMPDIR: testTmpDir,
      TMP: testTmpDir,
      TEMP: testTmpDir,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  rmSync(testTmpDir, { recursive: true, force: true });

  if (result.exitCode === 0) {
    passedFiles += 1;
    continue;
  }

  failedFiles += 1;
}

// Remove this runner's own subdir at completion. Sibling runners are untouched.
rmSync(RUNNER_DIR, { recursive: true, force: true });

console.log(`\nTest files: ${testFiles.length}, passed: ${passedFiles}, failed: ${failedFiles}`);
process.exit(failedFiles === 0 ? 0 : 1);
