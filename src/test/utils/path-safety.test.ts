import { describe, test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';

// config.workingDir = process.cwd() (frozen at import time, cannot be mutated)
// Tests run from the project root, so we test path validation relative to it.

const PROJECT_ROOT = process.cwd();

describe('resolveAndValidatePath', () => {
  test('resolves a relative path within project root', () => {
    const result = resolveAndValidatePath('src/main.ts');
    expect(result).toBe(join(PROJECT_ROOT, 'src/main.ts'));
  });

  test('resolves a nested relative path', () => {
    const result = resolveAndValidatePath('src/tools/file-read.ts');
    expect(result).toBe(join(PROJECT_ROOT, 'src/tools/file-read.ts'));
  });

  test('resolves current directory (.)', () => {
    const result = resolveAndValidatePath('.');
    expect(result).toBe(PROJECT_ROOT);
  });

  test('resolves an absolute path inside the project root', () => {
    const absPath = join(PROJECT_ROOT, 'src', 'main.ts');
    const result = resolveAndValidatePath(absPath);
    expect(result).toBe(absPath);
  });

  test('throws for path that escapes root via ..', () => {
    expect(() => resolveAndValidatePath('../../../etc/passwd')).toThrow(
      /outside the project root/
    );
  });

  test('throws for absolute path outside project root', () => {
    expect(() => resolveAndValidatePath('/etc/passwd')).toThrow(
      /outside the project root/
    );
  });

  test('throws for /tmp path', () => {
    expect(() => resolveAndValidatePath('/tmp/evil')).toThrow(
      /outside the project root/
    );
  });

  test('throws for path with embedded ..', () => {
    // Resolved path still escapes, even if starts without ..
    expect(() => resolveAndValidatePath('src/../../../../../../etc/shadow')).toThrow(
      /outside the project root/
    );
  });

  test('returns the resolved absolute path as string', () => {
    const result = resolveAndValidatePath('package.json');
    expect(typeof result).toBe('string');
    expect(result).toBe(resolve(PROJECT_ROOT, 'package.json'));
  });
});
