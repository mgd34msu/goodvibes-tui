import { describe, expect, test } from 'bun:test';
import { filterTestFilesByPattern, parseTestPattern } from '../../../scripts/test-pattern-rule.ts';

describe('parseTestPattern', () => {
  test('returns undefined with no args', () => {
    expect(parseTestPattern([])).toBeUndefined();
  });

  test('returns undefined when only known flags are present', () => {
    expect(parseTestPattern(['--coverage', '--jobs', '4'])).toBeUndefined();
  });

  test('returns the first non-flag positional token', () => {
    expect(parseTestPattern(['diff-runtime'])).toBe('diff-runtime');
  });

  test('skips --coverage and --jobs N before finding the pattern', () => {
    expect(parseTestPattern(['--coverage', '--jobs', '4', 'diff-runtime'])).toBe('diff-runtime');
  });

  test('ignores unrecognized flags rather than treating them as the pattern', () => {
    expect(parseTestPattern(['--weird-flag', 'diff-runtime'])).toBe('diff-runtime');
  });

  test('a shell-injection-looking pattern is still just a plain string value', () => {
    expect(parseTestPattern(['; rm -rf /tmp/x'])).toBe('; rm -rf /tmp/x');
  });

  test("--timeout's VALUE is skipped, never mistaken for the pattern", () => {
    // A value-taking flag whose value is not skipped is read as the pattern,
    // and the run then filters every test file out and exits 1, a silent way
    // to run nothing at all.
    expect(parseTestPattern(['--timeout', '60000'])).toBeUndefined();
    expect(parseTestPattern(['--timeout', '60000', 'diff-runtime'])).toBe('diff-runtime');
    expect(parseTestPattern(['--coverage', '--jobs', '4', '--timeout', '60000', 'diff-runtime'])).toBe('diff-runtime');
  });

  test('--timeout=N is a single token and needs no value skip', () => {
    expect(parseTestPattern(['--timeout=60000', 'diff-runtime'])).toBe('diff-runtime');
  });
});

describe('filterTestFilesByPattern', () => {
  const root = '/repo';
  const files = [
    '/repo/src/test/input/diff-runtime.test.ts',
    '/repo/src/test/input/git-runtime.test.ts',
    '/repo/src/test/scripts/coverage-gate.test.ts',
  ];

  test('returns all files unchanged when pattern is undefined', () => {
    expect(filterTestFilesByPattern(files, root, undefined)).toEqual(files);
  });

  test('filters by substring against the path relative to root', () => {
    expect(filterTestFilesByPattern(files, root, 'diff-runtime')).toEqual([
      '/repo/src/test/input/diff-runtime.test.ts',
    ]);
  });

  test('supports directory-scoped patterns', () => {
    expect(filterTestFilesByPattern(files, root, 'src/test/input')).toEqual([
      '/repo/src/test/input/diff-runtime.test.ts',
      '/repo/src/test/input/git-runtime.test.ts',
    ]);
  });

  test('returns an empty array when nothing matches', () => {
    expect(filterTestFilesByPattern(files, root, 'nonexistent-pattern')).toEqual([]);
  });
});
