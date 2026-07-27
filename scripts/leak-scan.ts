/**
 * Runs every test file in ONE bun process with the timer-leak detector
 * preloaded, and reports the handles still live when the run ends.
 *
 * This is deliberately NOT how `scripts/run-tests.ts` runs the suite. That
 * runner gives each file its own process, which is the right default — it is
 * what keeps a poller one test forgot from firing inside an unrelated later
 * file. But process isolation also HIDES those pollers: the process exits and
 * takes them with it, so nothing is ever measured. Collapsing the suite into a
 * single process for this scan is what makes a leak observable at all.
 *
 *   bun scripts/leak-scan.ts                       # every test file
 *   bun scripts/leak-scan.ts src/test/foo.test.ts  # one file
 *
 * A file that fails to LOAD contributes nothing to the report, so the loaded
 * count is printed alongside the discovered count: a scan that measured a
 * fraction of the suite must never be read as a clean bill of health for the
 * rest of it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

function discoverTestFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.test-tmp') continue;
      discoverTestFiles(full, found);
    } else if (TEST_FILE_RE.test(entry.name)) {
      found.push(relative(ROOT, full));
    }
  }
  return found;
}

const args = process.argv.slice(2);
const testArgs = args.length > 0 ? args : discoverTestFiles(join(ROOT, 'src')).sort();
const reportPath = process.env.GOODVIBES_LEAK_REPORT ?? resolve(ROOT, '.test-tmp/leak-report.json');

console.log(`leak-scan: ${testArgs.length} test file(s) discovered`);

const result = spawnSync(
  'bun',
  ['test', '--preload', './src/test/_helpers/leak-detector.ts', ...testArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      GOODVIBES_LEAK_DETECT: '1',
      GOODVIBES_LEAK_REPORT: reportPath,
    },
  },
);

console.log(`\nleak report written to ${reportPath}`);
if (result.status !== 0) {
  console.log(`(suite exited ${result.status ?? 'null'} — leak data above is still valid)`);
}
