import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillByTrigger } from '@pellux/goodvibes-sdk/platform/tools';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const PROJECT_ROOT = process.cwd();

function makeTmpDir(): string {
  // makeProjectTempDir registers the directory with the shared cleanup registry,
  // so the test process removes it before it ends. The hand-rolled creation this
  // replaced was tracked by nothing and left directories under .test-tmp behind
  // after a fully green run.
  return makeProjectTempDir('skill-loader');
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
