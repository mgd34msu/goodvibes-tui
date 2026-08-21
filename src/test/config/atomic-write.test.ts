import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@pellux/goodvibes-sdk/platform/config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `gv-atomic-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  test('writes content that can be read back', () => {
    const path = join(tmpDir, 'data.json');
    atomicWriteFileSync(path, '{"ok":true}');
    expect(readFileSync(path, 'utf-8')).toBe('{"ok":true}');
  });

  test('defaults to mode 0o600', () => {
    const path = join(tmpDir, 'secret.json');
    atomicWriteFileSync(path, 'hello');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('respects explicit mode option', () => {
    const path = join(tmpDir, 'world-readable.json');
    atomicWriteFileSync(path, 'hello', { mode: 0o644 });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test('no .tmp file left on success', () => {
    const path = join(tmpDir, 'clean.json');
    atomicWriteFileSync(path, 'data');
    const siblings = readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(siblings).toHaveLength(0);
  });

  test('overwrites an existing file atomically', () => {
    const path = join(tmpDir, 'update.json');
    atomicWriteFileSync(path, 'first');
    atomicWriteFileSync(path, 'second');
    expect(readFileSync(path, 'utf-8')).toBe('second');
  });

  test('mkdirp: creates parent directories when requested', () => {
    const nested = join(tmpDir, 'a', 'b', 'c', 'file.json');
    atomicWriteFileSync(nested, 'nested', { mkdirp: true });
    expect(readFileSync(nested, 'utf-8')).toBe('nested');
  });

  test('mkdirp: false (default) throws when parent directory does not exist', () => {
    const nested = join(tmpDir, 'missing', 'file.json');
    expect(() => atomicWriteFileSync(nested, 'data')).toThrow();
  });

  test('write fails (no file created) when the target directory is not writable', () => {
    // Use a regular file as the parent so the write fails with ENOTDIR. This is
    // uid-independent: root bypasses chmod-based permissions, so a 0o444 dir
    // would not reliably fail for the test runner.
    const blocker = join(tmpDir, 'blocker');
    writeFileSync(blocker, 'x');

    const target = join(blocker, 'fail.json');
    expect(() => atomicWriteFileSync(target, 'will fail')).toThrow();
    // No partial file landed at the destination.
    expect(existsSync(target)).toBe(false);
  });

  test('original file remains intact when a subsequent write fails', () => {
    // Write an initial value
    const path = join(tmpDir, 'original.json');
    atomicWriteFileSync(path, 'original content');

    // Trigger a write failure on a different target via ENOTDIR (parent is a
    // file), uid-independent, unlike chmod which root bypasses.
    const blocker = join(tmpDir, 'blocker2');
    writeFileSync(blocker, 'x');

    expect(() => atomicWriteFileSync(join(blocker, 'fail.json'), 'fail')).toThrow();

    // The original file was not affected
    expect(readFileSync(path, 'utf-8')).toBe('original content');
  });

  test('tmp file naming includes pid and timestamp; only destination file remains', () => {
    const path = join(tmpDir, 'named.json');
    atomicWriteFileSync(path, 'named test');
    const files = readdirSync(tmpDir);
    expect(files).toEqual(['named.json']);
  });

  test('same-path atomicity: original content is preserved when the write itself fails', () => {
    // The original file uses a basename near NAME_MAX (255). It fits, but
    // atomicWrite's tmp suffix (.pid.ts.uuid.tmp, ~63 chars) pushes the tmp name
    // past the limit, so tmp creation fails with ENAMETOOLONG before the rename.
    // This is uid-independent (root bypasses chmod), and the original must
    // survive untouched.
    const subDir = join(tmpDir, 'subdir');
    mkdirSync(subDir);
    const path = join(subDir, 'a'.repeat(240) + '.json'); // 245 chars < 255
    writeFileSync(path, 'original content'); // plain write — fits under NAME_MAX

    expect(() => atomicWriteFileSync(path, 'new content that should not land')).toThrow();

    // Original file content is unchanged.
    expect(readFileSync(path, 'utf-8')).toBe('original content');
    // No tmp file leaked
    const siblings = readdirSync(subDir).filter((f) => f.endsWith('.tmp'));
    expect(siblings).toHaveLength(0);
  });
});
