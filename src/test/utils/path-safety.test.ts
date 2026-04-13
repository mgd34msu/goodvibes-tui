import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';

// Tests run relative to the repo root, so we validate paths against that explicit root.

const PROJECT_ROOT = process.cwd();

describe('resolveAndValidatePath', () => {
  test('resolves a relative path within project root', () => {
    const result = resolveAndValidatePath('src/main.ts', PROJECT_ROOT);
    expect(result).toBe(join(PROJECT_ROOT, 'src/main.ts'));
  });

  test('resolves a nested relative path', () => {
    const result = resolveAndValidatePath('src/tools/registry.ts', PROJECT_ROOT);
    expect(result).toBe(join(PROJECT_ROOT, 'src/tools/registry.ts'));
  });

  test('resolves current directory (.)', () => {
    const result = resolveAndValidatePath('.', PROJECT_ROOT);
    expect(result).toBe(PROJECT_ROOT);
  });

  test('resolves an absolute path inside the project root', () => {
    const absPath = join(PROJECT_ROOT, 'src', 'main.ts');
    const result = resolveAndValidatePath(absPath, PROJECT_ROOT);
    expect(result).toBe(absPath);
  });

  test('throws for path that escapes root via ..', () => {
    expect(() => resolveAndValidatePath('../../../etc/passwd', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for absolute path outside project root', () => {
    expect(() => resolveAndValidatePath('/etc/passwd', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for /tmp path', () => {
    expect(() => resolveAndValidatePath('/tmp/evil', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for path with embedded ..', () => {
    // Resolved path still escapes, even if starts without ..
    expect(() => resolveAndValidatePath('src/../../../../../../etc/shadow', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for symlinks that escape the project root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gv-path-safety-'));
    const outsideFile = join(outside, 'secret.txt');
    const linkPath = join(PROJECT_ROOT, `.gv-path-link-${process.pid}-${Date.now()}`);
    writeFileSync(outsideFile, 'secret');
    symlinkSync(outsideFile, linkPath);

    try {
      expect(() => resolveAndValidatePath(linkPath, PROJECT_ROOT)).toThrow(/outside the project root/);
    } finally {
      rmSync(linkPath, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('returns the resolved absolute path as string', () => {
    const result = resolveAndValidatePath('package.json', PROJECT_ROOT);
    expect(typeof result).toBe('string');
    expect(result).toBe(resolve(PROJECT_ROOT, 'package.json'));
  });
});
