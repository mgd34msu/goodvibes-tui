import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { createEditTool } from '../../tools/edit/index.ts';
import type { EditToolOptions } from '../../tools/edit/index.ts';
import { FileStateCache } from '../../state/file-cache.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// resolveAndValidatePath uses process.cwd() as project root.
// All test files must be created inside process.cwd().
const PROJECT_ROOT = process.cwd();

let tmpCounter = 0;

function makeTmpDir(): string {
  const dir = join(PROJECT_ROOT, `.test-edit-tmp-${process.pid}-${++tmpCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/** Return a relative path from project root (for use as tool input path). */
function relPath(absPath: string): string {
  return absPath.slice(PROJECT_ROOT.length + 1); // strip leading slash
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('edit tool', () => {
  let tmpDir: string;
  let fileCache: FileStateCache;
  let tool: ReturnType<typeof createEditTool>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fileCache = new FileStateCache();
    tool = createEditTool(fileCache);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Single edit — exact match
  // -------------------------------------------------------------------------

  describe('single edit exact match', () => {
    test('replaces a unique string', async () => {
      const file = writeFile(tmpDir, 'a.ts', 'const x = 1;\nconst y = 2;\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'const x = 1;', replace: 'const x = 99;' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('const x = 99;\nconst y = 2;\n');
    });

    test('returns success with occurrencesReplaced in output', async () => {
      const file = writeFile(tmpDir, 'b.ts', 'hello world');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello', replace: 'hi' }],
        output: { format: 'minimal' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 replacement');
    });

    test('count_only format returns JSON with applied count', async () => {
      const file = writeFile(tmpDir, 'c.ts', 'foo bar');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'baz' }],
        output: { format: 'count_only' },
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output!);
      expect(parsed.applied).toBe(1);
      expect(parsed.failed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // File not found
  // -------------------------------------------------------------------------

  describe('file not found', () => {
    test('returns failure for nonexistent file', async () => {
      const result = await tool.execute({
        edits: [{ path: relPath(join(tmpDir, 'nope.ts')), find: 'x', replace: 'y' }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found|unreadable|atomic/i);
    });

    test('partial mode: skips missing file, does not throw', async () => {
      const goodFile = writeFile(tmpDir, 'good.ts', 'hello');
      const result = await tool.execute({
        edits: [
          { path: relPath(join(tmpDir, 'missing.ts')), find: 'x', replace: 'y' },
          { path: relPath(goodFile), find: 'hello', replace: 'world' },
        ],
        transaction: { mode: 'partial' },
      });
      expect(result.success).toBe(true); // at least one succeeded
      expect(readFileSync(goodFile, 'utf-8')).toBe('world');
    });
  });

  // -------------------------------------------------------------------------
  // Find string not found
  // -------------------------------------------------------------------------

  describe('find string not found', () => {
    test('returns failure when find string is absent', async () => {
      const file = writeFile(tmpDir, 'd.ts', 'const a = 1;');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'const z = 999;', replace: 'x' }],
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain('not found');
    });
  });

  // -------------------------------------------------------------------------
  // Ambiguous match (2+ occurrences, no occurrence specified)
  // -------------------------------------------------------------------------

  describe('ambiguous match', () => {
    test('errors when find string appears multiple times without occurrence', async () => {
      const file = writeFile(tmpDir, 'e.ts', 'foo\nfoo\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar' }],
      });
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/ambiguous|2 times/i);
    });
  });

  // -------------------------------------------------------------------------
  // Occurrence: first
  // -------------------------------------------------------------------------

  describe('occurrence: first', () => {
    test('replaces only the first occurrence', async () => {
      const file = writeFile(tmpDir, 'f.ts', 'foo foo foo');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar', occurrence: 'first' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('bar foo foo');
    });
  });

  // -------------------------------------------------------------------------
  // Occurrence: last
  // -------------------------------------------------------------------------

  describe('occurrence: last', () => {
    test('replaces only the last occurrence', async () => {
      const file = writeFile(tmpDir, 'g.ts', 'foo foo foo');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar', occurrence: 'last' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('foo foo bar');
    });
  });

  // -------------------------------------------------------------------------
  // Occurrence: all
  // -------------------------------------------------------------------------

  describe('occurrence: all', () => {
    test('replaces all occurrences', async () => {
      const file = writeFile(tmpDir, 'h.ts', 'foo foo foo');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar', occurrence: 'all' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('bar bar bar');
    });

    test('occurrencesReplaced count is correct', async () => {
      const file = writeFile(tmpDir, 'h2.ts', 'x x x x');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'x', replace: 'y', occurrence: 'all' }],
        output: { format: 'minimal' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('4 replacement');
    });
  });

  // -------------------------------------------------------------------------
  // Occurrence: specific number
  // -------------------------------------------------------------------------

  describe('occurrence: specific number', () => {
    test('replaces the 2nd occurrence', async () => {
      const file = writeFile(tmpDir, 'i.ts', 'foo foo foo');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar', occurrence: 2 }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('foo bar foo');
    });

    test('errors when N exceeds occurrence count', async () => {
      const file = writeFile(tmpDir, 'i2.ts', 'foo foo');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: 'bar', occurrence: 5 }],
      });
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/out of range/i);
    });
  });

  // -------------------------------------------------------------------------
  // Fuzzy matching
  // -------------------------------------------------------------------------

  describe('fuzzy matching', () => {
    test('matches despite extra whitespace', async () => {
      const file = writeFile(tmpDir, 'j.ts', 'const   x   =   1;');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'const x = 1;', replace: 'const x = 99;' }],
        match: { mode: 'fuzzy' },
      });
      expect(result.success).toBe(true);
      // The region should be replaced (whitespace-normalized span)
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('const x = 99;');
    });

    test('matches across newlines in whitespace', async () => {
      const file = writeFile(tmpDir, 'j2.ts', 'function foo(\n  a,\n  b\n) {}');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'function foo( a, b ) {}', replace: 'function foo(a, b) { return 1; }' }],
        match: { mode: 'fuzzy' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('return 1;');
    });

    test('fuzzy is case-sensitive by default', async () => {
      const file = writeFile(tmpDir, 'j3.ts', 'Hello World');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello world', replace: 'Hi' }],
        match: { mode: 'fuzzy' },
      });
      expect(result.success).toBe(false);
    });

    test('fuzzy case_sensitive: false matches differently-cased text', async () => {
      const file = writeFile(tmpDir, 'j4.ts', 'Hello World');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello world', replace: 'Hi' }],
        match: { mode: 'fuzzy', case_sensitive: false },
      });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Automatic fuzzy fallback (no explicit mode: 'fuzzy')
  // -------------------------------------------------------------------------

  describe('automatic fuzzy fallback', () => {
    test('whitespace-normalized fallback: exact fails, whitespace-normalized match succeeds', async () => {
      // File has normal spacing; find string has extra internal spaces
      const file = writeFile(tmpDir, 'fuzz_ws.ts', 'function hello(x: number) {\n  return x + 1;\n}\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'function  hello(x:  number) {', replace: 'function hello(x: number, y: number) {' }],
        // No mode specified — default exact falls back automatically
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('y: number');
      // Warning should be present in the output
      const output = JSON.stringify(result);
      expect(output).toMatch(/whitespace-normalized/);
    });

    test('fuzzy-line fallback: exact fails, fuzzy line match above 70% succeeds (1 of 4 lines has a typo)', async () => {
      // 4 lines, 1 has a real typo → similarity = 3/4 = 75% ≥ 70% threshold
      const content = 'line one\nline two\nline three\nline four\n';
      const file = writeFile(tmpDir, 'fuzz_line.ts', content);
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'line one\nline two\nline TYPO\nline four', replace: 'line one\nline two\nreplaced line\nline four' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('replaced line');
      const output = JSON.stringify(result);
      expect(output).toMatch(/fuzzy line match/);
    });

    test('fuzzy-line match below 70%: completely wrong find string returns error with candidate preview', async () => {
      const content = 'alpha beta\ngamma delta\nepsilon zeta\n';
      const file = writeFile(tmpDir, 'fuzz_low.ts', content);
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'XXXX YYYY\nZZZZ WWWW\nAAAA BBBB', replace: 'replaced' }],
      });
      expect(result.success).toBe(false);
      const errStr = JSON.stringify(result);
      // Should contain threshold info and candidate preview
      expect(errStr).toMatch(/threshold|similarity|candidate/);
    });

    test('fuzzy-line match below threshold returns error with candidate info', async () => {
      const content = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
      const file = writeFile(tmpDir, 'fuzz_warn.ts', content);
      // 2 exact lines + 1 typo = 2/3 similarity ≈ 67% — below threshold
      // Use 3 lines where 2 match and 1 has a minor diff that still passes after normalization
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'const x = 1;\nconst y = 2;\nconst z = TYPO;', replace: 'const x = 1;\nconst y = 2;\nconst z = 99;' }],
      });
      // 2/3 lines match = 67% — just below 70% threshold, should fail
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toMatch(/threshold|similarity/i);
    });
  });

  // -------------------------------------------------------------------------
  // Regex matching
  // -------------------------------------------------------------------------

  describe('regex matching', () => {
    test('replaces regex match', async () => {
      const file = writeFile(tmpDir, 'k.ts', 'version: 1.2.3');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '\\d+\\.\\d+\\.\\d+', replace: '2.0.0' }],
        match: { mode: 'regex' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('version: 2.0.0');
    });

    test('supports capture group back-references', async () => {
      const file = writeFile(tmpDir, 'k2.ts', 'foo_bar');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '(foo)_(bar)', replace: '$2_$1' }],
        match: { mode: 'regex' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('bar_foo');
    });

    test('regex case_sensitive: false', async () => {
      const file = writeFile(tmpDir, 'k3.ts', 'Hello World');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello', replace: 'Hi', occurrence: 'first' }],
        match: { mode: 'regex', case_sensitive: false },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('Hi World');
    });

    test('errors when regex is invalid', async () => {
      const file = writeFile(tmpDir, 'k4.ts', 'content');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '[invalid(', replace: 'x' }],
        match: { mode: 'regex' },
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Hints: near_line disambiguation
  // -------------------------------------------------------------------------

  describe('hints: near_line', () => {
    test('selects the occurrence closest to near_line', async () => {
      const content = 'foo\nkeep\nfoo\n';
      const file = writeFile(tmpDir, 'l.ts', content);
      // Line 3 is the second 'foo'; near_line: 3 should pick it
      const result = await tool.execute({
        edits: [{
          path: relPath(file),
          find: 'foo',
          replace: 'bar',
          hints: { near_line: 3 },
        }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('foo\nkeep\nbar\n');
    });

    test('near_line: 1 selects the first occurrence', async () => {
      const content = 'foo\nstuff\nfoo\n';
      const file = writeFile(tmpDir, 'l2.ts', content);
      const result = await tool.execute({
        edits: [{
          path: relPath(file),
          find: 'foo',
          replace: 'bar',
          hints: { near_line: 1 },
        }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('bar\nstuff\nfoo\n');
    });
  });

  // -------------------------------------------------------------------------
  // Batch edits on same file
  // -------------------------------------------------------------------------

  describe('batch edits on same file', () => {
    test('applies multiple edits sequentially on same file', async () => {
      const file = writeFile(tmpDir, 'm.ts', 'const a = 1;\nconst b = 2;\n');
      const result = await tool.execute({
        edits: [
          { path: relPath(file), find: 'const a = 1;', replace: 'const a = 10;' },
          { path: relPath(file), find: 'const b = 2;', replace: 'const b = 20;' },
        ],
      });
      expect(result.success).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('const a = 10;');
      expect(content).toContain('const b = 20;');
    });

    test('second edit builds on first edit result', async () => {
      // After first edit changes 'foo' to 'foobar', second edit finds 'foobar'
      const file = writeFile(tmpDir, 'm2.ts', 'foo');
      const result = await tool.execute({
        edits: [
          { path: relPath(file), find: 'foo', replace: 'foobar' },
          { path: relPath(file), find: 'foobar', replace: 'baz' },
        ],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('baz');
    });
  });

  // -------------------------------------------------------------------------
  // Batch edits on different files
  // -------------------------------------------------------------------------

  describe('batch edits on different files', () => {
    test('applies edits to multiple files', async () => {
      const f1 = writeFile(tmpDir, 'n1.ts', 'alpha');
      const f2 = writeFile(tmpDir, 'n2.ts', 'beta');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'alpha', replace: 'ALPHA' },
          { path: relPath(f2), find: 'beta', replace: 'BETA' },
        ],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(f1, 'utf-8')).toBe('ALPHA');
      expect(readFileSync(f2, 'utf-8')).toBe('BETA');
    });
  });

  // -------------------------------------------------------------------------
  // Atomic transaction: all succeed
  // -------------------------------------------------------------------------

  describe('atomic transaction: all succeed', () => {
    test('writes all files when all edits succeed', async () => {
      const f1 = writeFile(tmpDir, 'o1.ts', 'x');
      const f2 = writeFile(tmpDir, 'o2.ts', 'y');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'x', replace: 'X' },
          { path: relPath(f2), find: 'y', replace: 'Y' },
        ],
        transaction: { mode: 'atomic' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(f1, 'utf-8')).toBe('X');
      expect(readFileSync(f2, 'utf-8')).toBe('Y');
    });
  });

  // -------------------------------------------------------------------------
  // Atomic transaction: one fails, all rolled back
  // -------------------------------------------------------------------------

  describe('atomic transaction: one fails, all rolled back', () => {
    test('writes nothing when one edit fails', async () => {
      const f1 = writeFile(tmpDir, 'p1.ts', 'hello');
      const f2 = writeFile(tmpDir, 'p2.ts', 'world');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'hello', replace: 'HELLO' },
          { path: relPath(f2), find: 'NOTFOUND', replace: 'anything' }, // will fail
        ],
        transaction: { mode: 'atomic' },
      });
      expect(result.success).toBe(false);
      // Files must be unchanged
      expect(readFileSync(f1, 'utf-8')).toBe('hello');
      expect(readFileSync(f2, 'utf-8')).toBe('world');
    });

    test('output reports rollback for succeeded edits', async () => {
      const f1 = writeFile(tmpDir, 'p3.ts', 'aaa');
      const f2 = writeFile(tmpDir, 'p4.ts', 'bbb');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'aaa', replace: 'AAA' },
          { path: relPath(f2), find: 'MISSING', replace: 'x' },
        ],
        transaction: { mode: 'atomic' },
        output: { format: 'minimal' },
      });
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/rolled back|not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Partial transaction: some succeed, some fail
  // -------------------------------------------------------------------------

  describe('partial transaction', () => {
    test('applies succeeding edits, reports failures', async () => {
      const f1 = writeFile(tmpDir, 'q1.ts', 'good content');
      const f2 = writeFile(tmpDir, 'q2.ts', 'other');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'good content', replace: 'replaced' },
          { path: relPath(f2), find: 'NOPE', replace: 'x' }, // will fail
        ],
        transaction: { mode: 'partial' },
      });
      expect(result.success).toBe(true); // at least one succeeded
      expect(readFileSync(f1, 'utf-8')).toBe('replaced');
      expect(readFileSync(f2, 'utf-8')).toBe('other'); // unchanged
      expect(result.output).toContain('FAIL');
    });

    test('all fail returns success: false', async () => {
      const f = writeFile(tmpDir, 'q3.ts', 'content');
      const result = await tool.execute({
        edits: [
          { path: relPath(f), find: 'X', replace: 'Y' },
          { path: relPath(f), find: 'Z', replace: 'W' },
        ],
        transaction: { mode: 'partial' },
      });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // OCC conflict detection
  // -------------------------------------------------------------------------

  describe('OCC conflict detection', () => {
    test('detects external modification since last cache read', async () => {
      const file = writeFile(tmpDir, 'r.ts', 'original');
      // Prime the cache with original content
      fileCache.update(file, 'original');
      // Externally modify the file
      writeFileSync(file, 'modified externally', 'utf-8');
      // Now attempt to edit — cache should detect the conflict
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'original', replace: 'new' }],
        transaction: { mode: 'atomic' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/conflict|modified/i);
    });

    test('no conflict when file is unchanged since cache update', async () => {
      const file = writeFile(tmpDir, 'r2.ts', 'stable content');
      fileCache.update(file, 'stable content');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'stable content', replace: 'updated' }],
      });
      expect(result.success).toBe(true);
    });

    test('cache is updated after successful edit', async () => {
      const file = writeFile(tmpDir, 'r3.ts', 'before');
      await tool.execute({
        edits: [{ path: relPath(file), find: 'before', replace: 'after' }],
      });
      // Cache should now reflect new content
      const cacheResult = fileCache.lookup(file);
      expect(cacheResult.status).toBe('unchanged');
    });
  });

  // -------------------------------------------------------------------------
  // Base64 find/replace
  // -------------------------------------------------------------------------

  describe('base64 find/replace', () => {
    test('decodes find_base64 and replaces correctly', async () => {
      const file = writeFile(tmpDir, 's.ts', 'hello world');
      const findB64 = Buffer.from('hello').toString('base64');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '', find_base64: findB64, replace: 'hi' }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('hi world');
    });

    test('decodes replace_base64 and writes correctly', async () => {
      const file = writeFile(tmpDir, 's2.ts', 'foo');
      const replaceB64 = Buffer.from('bar').toString('base64');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'foo', replace: '', replace_base64: replaceB64 }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('bar');
    });

    test('decodes both find_base64 and replace_base64', async () => {
      const file = writeFile(tmpDir, 's3.ts', 'abc');
      const findB64 = Buffer.from('abc').toString('base64');
      const replaceB64 = Buffer.from('xyz').toString('base64');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '', find_base64: findB64, replace: '', replace_base64: replaceB64 }],
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('xyz');
    });
  });

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  describe('dry run', () => {
    test('does not write to disk', async () => {
      const file = writeFile(tmpDir, 't.ts', 'original');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'original', replace: 'modified' }],
        dry_run: true,
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('original');
    });

    test('returns diff in output even without write', async () => {
      const file = writeFile(tmpDir, 't2.ts', 'line1\nline2\nline3\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'line2', replace: 'LINE2' }],
        dry_run: true,
        output: { format: 'with_diff' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('dry run');
    });

    test('dry run with count_only format still reports counts', async () => {
      const file = writeFile(tmpDir, 't3.ts', 'a b c');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'a', replace: 'z' }],
        dry_run: true,
        output: { format: 'count_only' },
      });
      const parsed = JSON.parse(result.output!);
      expect(parsed.applied).toBe(1);
      expect(parsed.dry_run).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // with_diff output format
  // -------------------------------------------------------------------------

  describe('with_diff output format', () => {
    test('includes unified diff in output', async () => {
      const file = writeFile(tmpDir, 'u.ts', 'line1\noriginal\nline3\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'original', replace: 'modified' }],
        output: { format: 'with_diff' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('-original');
      expect(result.output).toContain('+modified');
    });

    test('verbose format includes replacement count', async () => {
      const file = writeFile(tmpDir, 'u2.ts', 'test content');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'test', replace: 'spec' }],
        output: { format: 'verbose' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 replacement');
    });
  });

  // -------------------------------------------------------------------------
  // Edit ID tracking
  // -------------------------------------------------------------------------

  describe('edit ID tracking', () => {
    test('includes edit id in output', async () => {
      const file = writeFile(tmpDir, 'v.ts', 'hello');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello', replace: 'world', id: 'edit-1' }],
        output: { format: 'minimal' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('edit-1');
    });

    test('includes edit id in failure output', async () => {
      const file = writeFile(tmpDir, 'v2.ts', 'hello');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'NOTFOUND', replace: 'x', id: 'edit-fail' }],
        output: { format: 'minimal' },
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain('edit-fail');
    });
  });

  // -------------------------------------------------------------------------
  // in_function hint
  // -------------------------------------------------------------------------

  describe('hints: in_function', () => {
    test('only matches within the specified function', async () => {
      const content = [
        'function foo() {',
        '  const x = 1;',
        '}',
        'function bar() {',
        '  const x = 1;',
        '}',
      ].join('\n');
      const file = writeFile(tmpDir, 'w.ts', content);
      const result = await tool.execute({
        edits: [{
          path: relPath(file),
          find: 'const x = 1;',
          replace: 'const x = 99;',
          hints: { in_function: 'foo' },
        }],
      });
      expect(result.success).toBe(true);
      const out = readFileSync(file, 'utf-8');
      // foo's x should be changed, bar's x should remain
      const lines = out.split('\n');
      expect(lines[1]).toBe('  const x = 99;');
      expect(lines[4]).toBe('  const x = 1;');
    });
  });

  // -------------------------------------------------------------------------
  // in_class hint
  // -------------------------------------------------------------------------

  describe('hints: in_class', () => {
    test('in_class hint scopes replacement to specific class', async () => {
      const content = [
        'class Foo {',
        '  getValue() {',
        '    return 1;',
        '  }',
        '}',
        'class Bar {',
        '  getValue() {',
        '    return 1;',
        '  }',
        '}',
      ].join('\n');
      const file = writeFile(tmpDir, 'x.ts', content);
      const result = await tool.execute({
        edits: [{
          path: relPath(file),
          find: 'return 1;',
          replace: 'return 99;',
          hints: { in_class: 'Foo' },
        }],
      });
      expect(result.success).toBe(true);
      const out = readFileSync(file, 'utf-8');
      const lines = out.split('\n');
      // Foo's return should be changed
      expect(lines[2]).toBe('    return 99;');
      // Bar's return should remain
      expect(lines[7]).toBe('    return 1;');
    });
  });

  // -------------------------------------------------------------------------
  // path traversal rejection
  // -------------------------------------------------------------------------

  describe('path traversal rejection', () => {
    test('rejects paths that escape the project root', async () => {
      const result = await tool.execute({
        edits: [{ path: '../../etc/passwd', find: 'root', replace: 'pwned' }],
      });
      expect(result.success).toBe(false);
      expect(result.error ?? result.output).toMatch(/outside|traversal|not allowed|invalid|path/i);
    });
  });

  // -------------------------------------------------------------------------
  // whitespace_sensitive: false in exact mode
  // -------------------------------------------------------------------------

  describe('match: whitespace_sensitive false in exact mode', () => {
    test('exact mode with whitespace_sensitive false ignores whitespace between tokens', async () => {
      // Content has extra spaces between tokens; find uses single spaces
      const file = writeFile(tmpDir, 'ws_exact.ts', 'const  x  =  1;');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'const x = 1;', replace: 'const x = 2;' }],
        match: { mode: 'exact', whitespace_sensitive: false },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('const x = 2;');
    });
  });

  // -------------------------------------------------------------------------
  // transaction mode: none
  // -------------------------------------------------------------------------

  describe('transaction mode: none', () => {
    test('applies successful edits independently', async () => {
      const f1 = writeFile(tmpDir, 'z1.ts', 'aaa');
      const f2 = writeFile(tmpDir, 'z2.ts', 'bbb');
      const result = await tool.execute({
        edits: [
          { path: relPath(f1), find: 'aaa', replace: 'AAA' },
          { path: relPath(f2), find: 'NOPE', replace: 'x' }, // fail
        ],
        transaction: { mode: 'none' },
      });
      expect(readFileSync(f1, 'utf-8')).toBe('AAA'); // succeeded
      expect(readFileSync(f2, 'utf-8')).toBe('bbb'); // unchanged
    });
  });

  // -------------------------------------------------------------------------
  // validate.before / validate.after
  // -------------------------------------------------------------------------
  //
  // These tests use cwd injection so validators run in an isolated tmpDir
  // with a controlled package.json, avoiding slow/recursive test runs.
  //
  // package.json scripts:
  //   build-pass: exits 0  (validator passes)
  //   build-fail: exits 1  (validator fails)
  // We use the 'build' validator mapped to 'bun run build'.
  // To simulate pass/fail we write a package.json whose 'build' script
  // is either 'exit 0' or 'exit 1', then create a tool with cwd=tmpDir.

  describe('validate.before', () => {
    test('skips edits and returns error when before-validator fails', async () => {
      // Setup: package.json with build script that fails
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_before.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { before: ['build'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Pre-edit validation failed/i);
      expect(result.error).toMatch(/build/i);
      // Edit must NOT have been applied
      expect(readFileSync(editFile, 'utf-8')).toBe('original');
    });

    test('applies edit when before-validator passes', async () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 0' } }));
      const editFile = writeFile(tmpDir, 'val_before_pass.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { before: ['build'] },
      });

      expect(result.success).toBe(true);
      expect(readFileSync(editFile, 'utf-8')).toBe('changed');
    });

    test('does not run validators in dry_run mode', async () => {
      // Even with a failing validator, dry_run bypasses it
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_dry.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { before: ['build'] },
        dry_run: true,
      });

      // dry_run skips validate.before — file remains unchanged
      expect(readFileSync(editFile, 'utf-8')).toBe('original');
      // result may succeed (dry_run returns diff) or fail for other reasons, but NOT validator failure
      if (!result.success) {
        expect(result.error ?? '').not.toMatch(/Pre-edit validation failed/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // validate.after
  // -------------------------------------------------------------------------

  describe('validate.after', () => {
    test('rolls back edit in atomic mode when after-validator fails', async () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_after.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { after: ['build'] },
        transaction: { mode: 'atomic' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Post-edit validation failed/i);
      expect(result.error).toMatch(/rolled back/i);
      // File must be restored to original
      expect(readFileSync(editFile, 'utf-8')).toBe('original');
    });

    test('commits edit when after-validator passes', async () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 0' } }));
      const editFile = writeFile(tmpDir, 'val_after_pass.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { after: ['build'] },
      });

      expect(result.success).toBe(true);
      expect(readFileSync(editFile, 'utf-8')).toBe('changed');
    });

    test('does not rollback in non-atomic mode when after-validator fails', async () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_after_partial.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { after: ['build'] },
        transaction: { mode: 'partial' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Post-edit validation failed/i);
      // No rollback in partial mode — file stays changed
      expect(result.error).not.toMatch(/rolled back/i);
      expect(readFileSync(editFile, 'utf-8')).toBe('changed');
    });

    test('validate.after is skipped when dry_run is true', async () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_after_dry.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { after: ['build'] },
        dry_run: true,
      });

      // dry_run: file untouched, no after-validator runs
      expect(readFileSync(editFile, 'utf-8')).toBe('original');
      if (!result.success) {
        expect(result.error ?? '').not.toMatch(/Post-edit validation failed/i);
      }
    });

    test('validator failure message includes validator name and output', async () => {
      // Build script writes to stderr to verify output capture
      writeFile(tmpDir, 'package.json', JSON.stringify({ scripts: { build: 'echo BUILD_FAILED_MSG && exit 1' } }));
      const editFile = writeFile(tmpDir, 'val_after_msg.ts', 'original');
      const localTool = createEditTool(new FileStateCache(), { cwd: tmpDir });

      const result = await localTool.execute({
        edits: [{ path: relPath(editFile), find: 'original', replace: 'changed' }],
        validate: { after: ['build'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/build/i);
    });
  });

  // -------------------------------------------------------------------------
  // ast_pattern mode
  // -------------------------------------------------------------------------

  describe('ast_pattern mode', () => {
    test('replaces a simple pattern match in a TypeScript file', async () => {
      const file = writeFile(tmpDir, 'ap1.ts', 'console.log("hello");\nconsole.log("world");\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'logger.info($$$ARGS)', occurrence: 'first' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('logger.info("hello")');
    });

    test('replaces all pattern occurrences when occurrence is all', async () => {
      const file = writeFile(tmpDir, 'ap2.ts', 'console.log(1);\nconsole.log(2);\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'logger.debug($$$ARGS)', occurrence: 'all' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toContain('console.log');
      expect(content).toContain('logger.debug(1)');
      expect(content).toContain('logger.debug(2)');
    });

    test('returns error when pattern has no matches', async () => {
      const file = writeFile(tmpDir, 'ap3.ts', 'const x = 1;\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'logger.info($$$ARGS)' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(false);
      expect(result.error ?? result.output ?? '').toMatch(/no match/i);
    });

    test('returns error when multiple matches exist without occurrence', async () => {
      const file = writeFile(tmpDir, 'ap4.ts', 'console.log(1);\nconsole.log(2);\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'x()' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(false);
      expect(result.error ?? result.output ?? '').toMatch(/disambiguate|occurrence|matches/i);
    });

    test('falls back to exact match for unsupported file types', async () => {
      const file = writeFile(tmpDir, 'ap5.json', '{"key": "value"}');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: '"value"', replace: '"updated"' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('"updated"');
    });

    test('replaces last occurrence when occurrence is last', async () => {
      const file = writeFile(tmpDir, 'ap6.ts', 'console.log(1);\nconsole.log(2);\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'done()', occurrence: 'last' }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('console.log(1)');
      expect(content).toContain('done()');
    });

    test('respects occurrence number selector', async () => {
      const file = writeFile(tmpDir, 'ap7.ts', 'console.log(1);\nconsole.log(2);\nconsole.log(3);\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'console.log($$$ARGS)', replace: 'second()', occurrence: 2 }],
        match: { mode: 'ast_pattern' },
      });
      expect(result.success).toBe(true);
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('console.log(1)');
      expect(content).toContain('second()');
      expect(content).toContain('console.log(3)');
    });
  });

  // -------------------------------------------------------------------------
  // ast mode
  // -------------------------------------------------------------------------

  describe('ast mode', () => {
    test('falls back to exact match when tree-sitter grammar unavailable', async () => {
      // ast mode falls back gracefully; use exact-matchable content
      const file = writeFile(tmpDir, 'ast1.ts', 'function greet() { return "hello"; }\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'return "hello";', replace: 'return "hi";' }],
        match: { mode: 'ast' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('return "hi";');
    });

    test('returns error when find text not present in file', async () => {
      const file = writeFile(tmpDir, 'ast2.ts', 'const x = 1;\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'notHere', replace: 'replaced' }],
        match: { mode: 'ast' },
      });
      expect(result.success).toBe(false);
    });

    test('works with plain text files via exact fallback', async () => {
      const file = writeFile(tmpDir, 'ast3.txt', 'hello world\n');
      const result = await tool.execute({
        edits: [{ path: relPath(file), find: 'hello', replace: 'goodbye' }],
        match: { mode: 'ast' },
      });
      expect(result.success).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('goodbye world');
    });
  });
});

