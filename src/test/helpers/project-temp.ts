import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_TEST_TMP_ROOT = join(process.cwd(), '.test-tmp');

function ensureProjectTestTmpRoot(): string {
  if (!existsSync(PROJECT_TEST_TMP_ROOT)) {
    mkdirSync(PROJECT_TEST_TMP_ROOT, { recursive: true });
  }
  return PROJECT_TEST_TMP_ROOT;
}

export function makeProjectTempDir(prefix: string): string {
  return mkdtempSync(join(ensureProjectTestTmpRoot(), `${prefix}-`));
}
