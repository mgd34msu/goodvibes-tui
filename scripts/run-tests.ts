import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SEARCH_ROOT = join(ROOT, 'src');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const TEST_TMP_ROOT = join(ROOT, '.test-tmp', 'suite');

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

rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
mkdirSync(TEST_TMP_ROOT, { recursive: true });

if (testFiles.length === 0) {
  console.error('No test files found under src/');
  process.exit(1);
}

let passedFiles = 0;
let failedFiles = 0;

for (const testFile of testFiles) {
  const rel = relative(ROOT, testFile);
  const testTmpDir = join(
    TEST_TMP_ROOT,
    rel.replace(/[^a-z0-9_.-]+/gi, '-'),
  );
  rmSync(testTmpDir, { recursive: true, force: true });
  mkdirSync(testTmpDir, { recursive: true });
  console.log(`\n==> ${rel}`);
  const result = Bun.spawnSync(['bun', 'test', testFile], {
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

console.log(`\nTest files: ${testFiles.length}, passed: ${passedFiles}, failed: ${failedFiles}`);
process.exit(failedFiles === 0 ? 0 : 1);
