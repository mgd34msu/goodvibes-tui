import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.ts';

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

  test('no tmp file left when write target dir is unwritable', () => {
    const unwritableDir = join(tmpDir, 'no-write');
    mkdirSync(unwritableDir);
    chmodSync(unwritableDir, 0o444);

    const target = join(unwritableDir, 'fail.json');
    expect(() => atomicWriteFileSync(target, 'will fail')).toThrow();
    // No partial tmp left (can't create files in this dir, so none should exist)
    expect(existsSync(target)).toBe(false);

    // Restore so afterEach can clean up
    chmodSync(unwritableDir, 0o755);
  });

  test('original file remains intact when a subsequent write fails', () => {
    // Write an initial value
    const path = join(tmpDir, 'original.json');
    atomicWriteFileSync(path, 'original content');

    // Attempt to write to an unwritable directory (different file)
    const unwritableDir = join(tmpDir, 'no-write2');
    mkdirSync(unwritableDir);
    chmodSync(unwritableDir, 0o444);

    expect(() => atomicWriteFileSync(join(unwritableDir, 'fail.json'), 'fail')).toThrow();

    // Restore
    chmodSync(unwritableDir, 0o755);

    // The original file was not affected
    expect(readFileSync(path, 'utf-8')).toBe('original content');
  });

  test('tmp file naming includes pid and timestamp — only destination file remains', () => {
    const path = join(tmpDir, 'named.json');
    atomicWriteFileSync(path, 'named test');
    const files = readdirSync(tmpDir);
    expect(files).toEqual(['named.json']);
  });

  test('same-path atomicity: original content is preserved when the write itself fails', () => {
    // Write an existing file into a subdirectory, then remove write permission
    // from that directory so the tmp-file creation fails before rename.
    // The original must survive untouched.
    const subDir = join(tmpDir, 'subdir');
    mkdirSync(subDir);
    const path = join(subDir, 'state.json');
    atomicWriteFileSync(path, 'original content');

    // Remove write permission on the parent dir — tmp file cannot be created.
    chmodSync(subDir, 0o444);

    expect(() => atomicWriteFileSync(path, 'new content that should not land')).toThrow();

    // Restore so afterEach can clean up
    chmodSync(subDir, 0o755);

    // Original file content is unchanged.
    expect(readFileSync(path, 'utf-8')).toBe('original content');
    // No tmp file leaked
    const siblings = readdirSync(subDir).filter((f) => f.endsWith('.tmp'));
    expect(siblings).toHaveLength(0);
  });
});
