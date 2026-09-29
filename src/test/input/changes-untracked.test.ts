/**
 * The Changes modal lists untracked, non-ignored files as added files: their
 * whole content as added lines, binary files with a note, very large files
 * with a note instead of every line, ignored files left out, and the staged
 * source unaffected.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_UNTRACKED_LINES, loadDiff, loadUntrackedDiff } from '../../input/changes-git.ts';
import { hunkPatch, parseChanges } from '../../input/changes-model.ts';
import { buildDiffRows } from '../../renderer/changes-modal.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let repo = '';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
}

beforeAll(() => {
  repo = makeProjectTempDir('changes-untracked');
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n');
  writeFileSync(join(repo, 'tracked.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'tracked.ts'), 'export const a = 2;\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'new file.ts'), 'export const b = 1;\nexport const c = 2;\nexport const d = 3;\n');
  writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 7, 0]));
  writeFileSync(join(repo, 'huge.txt'), Array.from({ length: MAX_UNTRACKED_LINES + 10 }, (_, i) => `line ${i}`).join('\n') + '\n');
  writeFileSync(join(repo, 'ignored.log'), 'noise\n');
});

describe('untracked files in the Changes modal', () => {
  test('the working diff adds every untracked, non-ignored file after the tracked changes', async () => {
    const diff = await loadDiff(repo, 'working', []);
    expect(diff.error).toBeNull();
    const files = parseChanges(diff.raw);
    const paths = files.map((f) => f.path);
    expect(paths).toContain('tracked.ts');
    expect(paths).toContain('src/new file.ts');
    expect(paths).toContain('image.bin');
    expect(paths).toContain('huge.txt');
    expect(paths).not.toContain('ignored.log');
    expect(diff.label).toContain('3 untracked');
  });

  test('a new text file is all added lines, numbered from 1, and its hunk stages as a real patch', async () => {
    const files = parseChanges((await loadDiff(repo, 'working', [])).raw);
    const file = files.find((f) => f.path === 'src/new file.ts')!;
    expect(file.added).toBe(3);
    expect(file.removed).toBe(0);
    expect(file.headerOnly).toBe(false);
    const lines = file.hunks[0]!.lines;
    expect(lines.every((line) => line.kind === 'add')).toBe(true);
    expect(lines.map((line) => line.newNo)).toEqual([1, 2, 3]);
    expect(lines[0]!.text).toBe('export const b = 1;');
    // git accepts the hunk patch against the index (checked without applying it).
    execFileSync('git', ['apply', '--cached', '--check', '-'], { cwd: repo, input: hunkPatch(file, file.hunks[0]!), timeout: 30_000 });
  });

  test('binary files show as added with a binary note; very large files with a size note', async () => {
    const files = parseChanges((await loadDiff(repo, 'working', [])).raw);
    const binary = files.find((f) => f.path === 'image.bin')!;
    expect(binary.headerOnly).toBe(true);
    expect(buildDiffRows([binary], 60, false).rows.map((r) => ('text' in r ? r.text : ''))).toContain('binary file, no line changes to show');
    const huge = files.find((f) => f.path === 'huge.txt')!;
    expect(huge.headerOnly).toBe(true);
    expect(huge.note).toContain('large new file');
    expect(buildDiffRows([huge], 60, false).rows.some((r) => 'text' in r && r.text.includes('not shown line by line'))).toBe(true);
  });

  test('the session source takes only the untracked files this session wrote', async () => {
    const diff = await loadDiff(repo, 'session', ['src/new file.ts', 'tracked.ts']);
    const paths = parseChanges(diff.raw).map((f) => f.path);
    expect(paths.sort()).toEqual(['src/new file.ts', 'tracked.ts']);
  });

  test('the staged source leaves untracked files out', async () => {
    const diff = await loadDiff(repo, 'staged', []);
    expect(parseChanges(diff.raw).map((f) => f.path)).toEqual([]);
    expect(diff.label).toBe('staged');
  });

  test('a session path outside the repository does not hide the untracked files inside it', async () => {
    const result = await loadUntrackedDiff(repo, ['/definitely/not/in/this/repo.ts', 'src/new file.ts']);
    expect(result.count).toBe(1);
  });
});
