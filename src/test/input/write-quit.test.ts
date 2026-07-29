import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildWriteQuitCommitMessage, collectGitChanges, executeWriteQuit } from '../../input/commands/quit-shared.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeCommandContext(overrides: Partial<CommandContext> = {}): Pick<CommandContext, 'print' | 'exit'> {
  return {
    print: () => {},
    exit: () => {},
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('write quit helpers', () => {
  test('builds a readable commit subject from collected changes', () => {
    const changes = collectGitChanges({
      staged: ['src/main.ts', 'src/ui.ts'],
      modified: [],
      not_added: [],
      deleted: [],
      created: [],
      renamed: [],
    });

    expect(changes).toHaveLength(2);
    expect(buildWriteQuitCommitMessage(changes)).toBe('Update src files');
  });

  test('exits immediately when the current directory is not a git repo', async () => {
    let exitCount = 0;
    const printed: string[] = [];

    await executeWriteQuit(makeCommandContext({
      print: (text) => { printed.push(text); },
      exit: () => { exitCount++; },
    }), {
      cwd: '/tmp/non-git-dir',
      isGitRepo: () => false,
    });

    expect(exitCount).toBe(1);
    expect(printed).toEqual([]);
  });

  test('stages all changes, commits them, and then exits', async () => {
    const repoDir = makeProjectTempDir('goodvibes-wq');
    tempDirs.push(repoDir);

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
    writeFileSync(join(repoDir, 'README.md'), '# hello\n', 'utf-8');

    let exited = 0;
    const printed: string[] = [];

    await executeWriteQuit(makeCommandContext({
      print: (text) => { printed.push(text); },
      exit: () => { exited++; },
    }), { cwd: repoDir });

    const subject = execSync('git log -1 --pretty=%s', { cwd: repoDir }).toString('utf-8').trim();
    const porcelain = execSync('git status --porcelain', { cwd: repoDir }).toString('utf-8').trim();

    expect(subject).toBe('Add README.md');
    expect(porcelain).toBe('');
    expect(exited).toBe(1);
    expect(printed.some((line) => line.includes('[wq] Commit complete:'))).toBe(true);
  });

  test('does not exit when the commit step fails', async () => {
    let exited = 0;
    const printed: string[] = [];

    await executeWriteQuit(makeCommandContext({
      print: (text) => { printed.push(text); },
      exit: () => { exited++; },
    }), {
      cwd: '/repo',
      isGitRepo: () => true,
      getRepoRoot: () => '/repo',
      gitFactory: () => ({
        addAll: async () => {},
        status: async () => ({
          staged: ['src/app.ts'],
          modified: [],
          not_added: [],
          deleted: [],
          created: [],
          renamed: [],
          isClean: () => false,
        } as never),
        commit: async () => {
          throw new Error('commit rejected');
        },
      }),
    });

    expect(exited).toBe(0);
    expect(printed[printed.length - 1]).toContain('commit rejected');
  });
});
