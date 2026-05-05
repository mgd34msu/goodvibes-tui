import { describe, test, expect } from 'bun:test';
import { globToRegex, buildGlobMatcher } from '@pellux/goodvibes-sdk/platform/utils';

describe('globToRegex', () => {
  test('matches exact filename', () => {
    const re = globToRegex('foo.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('bar.ts')).toBe(false);
  });

  test('* matches filename characters but not slashes', () => {
    const re = globToRegex('*.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('bar.ts')).toBe(true);
    expect(re.test('src/foo.ts')).toBe(true); // (^|/) prefix means it matches segment
    expect(re.test('foo.tsx')).toBe(false);
  });

  test('** without slash matches deep paths via .+ wildcard', () => {
    const re = globToRegex('src/**');
    // '**' (without preceding slash) expands to .+ — matches any chars
    expect(re.test('src/deep/path/file.ts')).toBe(true);
  });

  test('* glob matches files in nested dirs via (^|/) anchor', () => {
    // *.ts uses (^|/) prefix so it matches filename at any path depth
    const re = globToRegex('*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('a/b/c/foo.ts')).toBe(true);
    expect(re.test('foo.ts')).toBe(true);
  });

  test('** without slash matches any chars', () => {
    const re = globToRegex('src/**');
    expect(re.test('src/foo')).toBe(true);
    expect(re.test('src/deep/path/file.ts')).toBe(true);
  });

  test('? matches single non-slash character', () => {
    const re = globToRegex('fo?.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('fo1.ts')).toBe(true);
    expect(re.test('ft.ts')).toBe(false);
  });

  test('escapes regex special chars in glob', () => {
    const re = globToRegex('file.ts'); // dot must be literal
    expect(re.test('fileXts')).toBe(false);
    expect(re.test('file.ts')).toBe(true);
  });

  test('returns a RegExp instance', () => {
    expect(globToRegex('*.ts')).toBeInstanceOf(RegExp);
  });

  test('matches at end of path segment', () => {
    const re = globToRegex('*.json');
    expect(re.test('package.json')).toBe(true);
    expect(re.test('package.json.bak')).toBe(false);
  });
});

describe('buildGlobMatcher', () => {
  test('returns a function', () => {
    expect(typeof buildGlobMatcher('*.ts')).toBe('function');
  });

  test('matcher returns true for matching path', () => {
    const match = buildGlobMatcher('*.ts');
    expect(match('foo.ts')).toBe(true);
  });

  test('matcher returns false for non-matching path', () => {
    const match = buildGlobMatcher('*.ts');
    expect(match('foo.js')).toBe(false);
  });

  test('normalises backslashes before matching', () => {
    const match = buildGlobMatcher('*.ts');
    // Windows-style path: backslash should be normalised to forward slash
    expect(match('src\\foo.ts')).toBe(true);
  });

  test('* glob matches files in nested paths', () => {
    // *.ts uses (^|/) prefix, so it matches at any depth
    const match = buildGlobMatcher('*.ts');
    expect(match('src/utils/helper.ts')).toBe(true);
    expect(match('src/utils/helper.js')).toBe(false);
  });
});
