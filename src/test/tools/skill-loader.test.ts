import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillByTrigger } from '@pellux/goodvibes-sdk/platform/tools';

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  const base = join(PROJECT_ROOT, '.test-tmp');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, 'skill-loader-'));
}

describe('skill loader', () => {
  let tmpDir = '';

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
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('materializes linked markdown when a matching trigger is loaded', () => {
    const content = loadSkillByTrigger('/demo', { workingDirectory: tmpDir });
    expect(content).toContain('Primary instructions.');
    expect(content).toContain('Expanded helper content.');
  });
});
