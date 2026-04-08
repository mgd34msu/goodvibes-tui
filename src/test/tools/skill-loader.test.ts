import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillByTrigger } from '../../tools/registry-tool/skill-loader.ts';

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  const base = join(PROJECT_ROOT, '.test-tmp');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'skill-loader-'));
}

describe('skill loader', () => {
  let tmpDir = '';
  let origCwd: () => string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, '.goodvibes', 'skills'), { recursive: true });
    writeFileSync(join(tmpDir, '.goodvibes', 'skills', 'part.md'), 'Expanded helper content.', 'utf-8');
    writeFileSync(
      join(tmpDir, '.goodvibes', 'skills', 'demo.md'),
      [
        '---',
        'name: demo',
        'triggers:',
        '  - /demo',
        '---',
        '',
        'Primary instructions.',
        '@part.md',
      ].join('\n'),
      'utf-8',
    );
    origCwd = process.cwd.bind(process);
    (process as unknown as Record<string, unknown>).cwd = () => tmpDir;
  });

  afterEach(() => {
    (process as unknown as Record<string, unknown>).cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('materializes linked markdown when a matching trigger is loaded', () => {
    const content = loadSkillByTrigger('/demo');
    expect(content).toContain('Primary instructions.');
    expect(content).toContain('Expanded helper content.');
  });
});
