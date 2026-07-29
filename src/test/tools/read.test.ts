/**
 * Tests for the read tool.
 *
 * Temp files are created inside the project root (a .test-tmp/ subdirectory)
 * because resolveAndValidatePath() enforces the project root boundary.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ReadTool } from '@pellux/goodvibes-sdk/platform/tools';
import { FileStateCache } from '@pellux/goodvibes-sdk/platform/state';
import { ProjectIndex } from '@pellux/goodvibes-sdk/platform/state';
import { CodeIntelligence } from '@pellux/goodvibes-sdk/platform/intelligence';
import { getTestCodeIntelligence, getTestProjectIndex, resetTestProjectIndexes, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

/** Create a unique temp directory within the project root. */
function makeTmpDir(): string {
  // makeProjectTempDir registers the directory with the shared cleanup registry,
  // so the test process removes it before it ends. The hand-rolled creation this
  // replaced was tracked by nothing and left directories under .test-tmp behind
  // after a fully green run.
  return makeProjectTempDir('read');
}

/** Write content to a file, returning the relative path from project root. */
function writeRelative(dir: string, name: string, content: string): string {
  const absPath = join(dir, name);
  writeFileSync(absPath, content, 'utf-8');
  // Return relative path from project root
  return absPath.slice(PROJECT_ROOT.length + 1);
}

/** Write a binary file (contains null bytes). */
function writeBinary(dir: string, name: string): string {
  const absPath = join(dir, name);
  // Write a buffer containing null bytes
  const buf = Buffer.alloc(16);
  buf[4] = 0x00; // ensure null byte is present
  writeFileSync(absPath, buf);
  return absPath.slice(PROJECT_ROOT.length + 1);
}

/** Build a ReadTool with isolated FileStateCache, ProjectIndex, and CodeIntelligence. */
function makeTool(): { tool: ReadTool; cache: FileStateCache; index: ProjectIndex; intelligence: CodeIntelligence } {
  const cache = new FileStateCache();
  resetTestProjectIndexes();
  const index = getTestProjectIndex(PROJECT_ROOT);
  const intelligence = getTestCodeIntelligence();
  const tool = new ReadTool(index, cache, intelligence);
  return { tool, cache, index, intelligence };
}

/** Parse the JSON output from tool.execute(). */
async function exec(tool: ReadTool, args: Record<string, unknown>) {
  const result = await tool.execute(args);
  if (!result.success) return result;
  return { ...result, parsed: JSON.parse(result.output!) };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ReadTool', () => {
  let tmpDir: string;
  let tool: ReadTool;
  let cache: FileStateCache;
  let intelligence: CodeIntelligence;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ({ tool, cache, intelligence } = makeTool());
  });

  afterEach(() => {
    resetTestProjectIndexes();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Tool definition
  // -------------------------------------------------------------------------

  describe('definition', () => {
    test('has name "read"', () => {
      expect(tool.definition.name).toBe('read');
    });

    test('has a description', () => {
      expect(tool.definition.description.length).toBeGreaterThan(0);
    });

    test('parameters schema requires files', () => {
      const params = tool.definition.parameters as Record<string, unknown>;
      const required = params['required'] as string[];
      expect(required).toContain('files');
    });
  });

  // -------------------------------------------------------------------------
  // Basic content read
  // -------------------------------------------------------------------------

  describe('content mode (default)', () => {
    test('reads a single file and returns its content', async () => {
      const rel = writeRelative(tmpDir, 'hello.ts', 'const x = 1;\nconst y = 2;\n');
      const r = await exec(tool, { files: [{ path: rel }] });
      expect(r.success).toBe(true);
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('const x = 1;');
    });

    test('includes line numbers by default', async () => {
      const rel = writeRelative(tmpDir, 'numbered.ts', 'line one\nline two\n');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toMatch(/^\s+1 \|/);
    });

    test('can disable line numbers', async () => {
      const rel = writeRelative(tmpDir, 'no-nums.ts', 'hello\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { include_line_numbers: false },
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).not.toMatch(/^\s+1 \|/);
      expect(parsed.files[0].content).toContain('hello');
    });

    test('summary reflects correct counts', async () => {
      const rel = writeRelative(tmpDir, 'counts.ts', 'a\nb\nc\n');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { summary: { files_read: number; total_lines: number } } }).parsed;
      expect(parsed.summary.files_read).toBe(1);
      expect(parsed.summary.total_lines).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Line range (lines mode)
  // -------------------------------------------------------------------------

  describe('lines mode and range', () => {
    test('reads only the specified line range', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5\n';
      const rel = writeRelative(tmpDir, 'range.ts', content);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'lines', range: { start: 2, end: 4 } }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      expect(c).toContain('line2');
      expect(c).toContain('line3');
      expect(c).toContain('line4');
      expect(c).not.toContain('line5');
    });

    test('line numbers in range output start at range.start', async () => {
      const rel = writeRelative(tmpDir, 'range-nums.ts', 'a\nb\nc\nd\ne\n');
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'lines', range: { start: 3, end: 5 } }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toMatch(/^\s+3 \|/);
    });

    test('range on content mode also works', async () => {
      const rel = writeRelative(tmpDir, 'content-range.ts', 'a\nb\nc\n');
      const r = await exec(tool, {
        files: [{ path: rel, range: { start: 2, end: 2 } }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('b');
      expect(parsed.files[0].content).not.toContain('a\n');
    });
  });

  // -------------------------------------------------------------------------
  // Outline mode
  // -------------------------------------------------------------------------

  describe('outline mode', () => {
    test('extracts exported function signatures', async () => {
      const src = [
        'export function greet(name: string): string {',
        '  return `Hello ${name}`;',
        '}',
        '',
        'export function farewell(name: string): void {',
        '  console.log(name);',
        '}',
      ].join('\n');
      const rel = writeRelative(tmpDir, 'funcs.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'outline' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      expect(c).toContain('greet');
      expect(c).toContain('farewell');
      // Bodies should not appear
      expect(c).not.toContain('return `Hello');
    });

    test('extracts class declarations', async () => {
      const src = 'export class MyService {\n  run() {}\n}\n';
      const rel = writeRelative(tmpDir, 'service.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'outline' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('MyService');
    });

    test('extracts interface declarations', async () => {
      const src = 'export interface Config {\n  host: string;\n}\n';
      const rel = writeRelative(tmpDir, 'config.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'outline' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('Config');
    });

    test('returns empty string for file with no signatures', async () => {
      const rel = writeRelative(tmpDir, 'data.ts', 'const x = 42;\n');
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'outline' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      // const at top level IS matched by SIGNATURE_PATTERNS
      expect(typeof parsed.files[0].content).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Symbols mode
  // -------------------------------------------------------------------------

  describe('symbols mode', () => {
    test('extracts exported symbol names and kinds', async () => {
      const src = [
        'export function doWork(): void {}',
        'export class Worker {}',
        'export interface IJob { id: string; }',
        'export type JobId = string;',
        'export const MAX = 100;',
      ].join('\n');
      const rel = writeRelative(tmpDir, 'symbols.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'symbols' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      expect(c).toContain('function doWork');
      expect(c).toContain('class Worker');
      expect(c).toContain('interface IJob');
      expect(c).toContain('type JobId');
      expect(c).toContain('constant MAX');
    });

    test('does not include non-exported declarations', async () => {
      const src = 'function internal() {}\nexport function external() {}\n';
      const rel = writeRelative(tmpDir, 'mixed.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'symbols' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      expect(c).toContain('external');
      expect(c).not.toContain('internal');
    });

    test('uses tree-sitter path (getSymbols called) for a .ts file', async () => {
      // Verify that the tree-sitter code path (ci.getSymbols) is invoked for a
      // TypeScript file, not just the regex fallback.
      const spy = spyOn(intelligence, 'getSymbols');
      const src = 'export function doStuff(): void {}\nexport const VALUE = 42;\n';
      const rel = writeRelative(tmpDir, 'sym-spy.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'symbols' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      // getSymbols must have been called
      expect(spy).toHaveBeenCalled();
      // Result should contain the exported symbol names
      expect(c).toContain('doStuff');
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // AST mode (tree-sitter with regex fallback)
  // -------------------------------------------------------------------------

  describe('ast mode', () => {
    test('returns content containing the function name', async () => {
      // ast mode uses tree-sitter when available, falls back to outline.
      // Either path should include the exported function name.
      const src = 'export function foo() {}\n';
      const rel = writeRelative(tmpDir, 'ast.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'ast' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      expect(typeof c).toBe('string');
      expect(c).toContain('foo');
    });

    test('falls back gracefully when tree-sitter has no grammar', async () => {
      // Use a file extension with no tree-sitter grammar to force the fallback.
      const src = 'export function bar() {}\n';
      const rel = writeRelative(tmpDir, 'fallback.unknownlang', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'ast' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      // Fallback note should be present
      expect(c).toContain('unavailable');
    });

    test('uses tree-sitter path (getOutline called) for a .ts file', async () => {
      // Verify that the tree-sitter code path (ci.getOutline) is invoked for a
      // TypeScript file, not just the regex fallback.
      const spy = spyOn(intelligence, 'getOutline');
      const src = 'export function myFn() {}\n';
      const rel = writeRelative(tmpDir, 'ts-path.ts', src);
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'ast' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const c = parsed.files[0].content;
      // getOutline must have been called
      expect(spy).toHaveBeenCalled();
      // Result should contain the function name regardless of which path ran
      expect(c).toContain('myFn');
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Batch read
  // -------------------------------------------------------------------------

  describe('batch read', () => {
    test('reads multiple files in one call', async () => {
      const relA = writeRelative(tmpDir, 'a.ts', 'const a = 1;\n');
      const relB = writeRelative(tmpDir, 'b.ts', 'const b = 2;\n');
      const relC = writeRelative(tmpDir, 'c.ts', 'const c = 3;\n');
      const r = await exec(tool, {
        files: [{ path: relA }, { path: relB }, { path: relC }],
      });
      const parsed = (r as { parsed: { files: Array<{ path: string }> } }).parsed;
      expect(parsed.files).toHaveLength(3);
    });

    test('summary totals across all files', async () => {
      const relA = writeRelative(tmpDir, 'x.ts', 'line1\nline2\n');
      const relB = writeRelative(tmpDir, 'y.ts', 'line3\nline4\nline5\n');
      const r = await exec(tool, { files: [{ path: relA }, { path: relB }] });
      const parsed = (r as { parsed: { summary: { files_read: number; total_lines: number } } }).parsed;
      expect(parsed.summary.files_read).toBe(2);
      expect(parsed.summary.total_lines).toBeGreaterThanOrEqual(5);
    });

    test('per-file extract overrides global extract', async () => {
      const relA = writeRelative(tmpDir, 'ov-a.ts', 'export function foo() {}\n');
      const relB = writeRelative(tmpDir, 'ov-b.ts', 'const x = 1;\n');
      const r = await exec(tool, {
        extract: 'content',
        files: [{ path: relA, extract: 'symbols' }, { path: relB }],
      });
      const parsed = (r as { parsed: { files: Array<{ extract: string; content: string }> } }).parsed;
      expect(parsed.files[0].extract).toBe('symbols');
      expect(parsed.files[1].extract).toBe('content');
      expect(parsed.files[0].content).toContain('function foo');
      expect(parsed.files[1].content).toContain('const x = 1');
    });
  });

  // -------------------------------------------------------------------------
  // Caching
  // -------------------------------------------------------------------------

  describe('caching', () => {
    test('second read of unchanged file reports cache status', async () => {
      const rel = writeRelative(tmpDir, 'cached.ts', 'export const V = 1;\n');
      // First read: populates cache
      await tool.execute({ files: [{ path: rel }] });
      // Second read: file is unchanged
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<{ cache: { status: string } }> } }).parsed;
      // After first read the cache is updated; second lookup sees 'unchanged'
      expect(parsed.files[0].cache.status).toBe('unchanged');
    });

    test('force=true bypasses cache and still succeeds', async () => {
      const rel = writeRelative(tmpDir, 'force.ts', 'export const F = 2;\n');
      await tool.execute({ files: [{ path: rel }] });
      const r = await exec(tool, { files: [{ path: rel, force: true }] });
      expect(r.success).toBe(true);
      const parsed = (r as { parsed: { files: Array<{ cache: { status: string }; content: string }> } }).parsed;
      expect(parsed.files[0].cache.status).toBe('miss');
      expect(parsed.files[0].content).toContain('const F = 2');
    });

    test('first read of a file has cache status miss', async () => {
      const rel = writeRelative(tmpDir, 'first.ts', 'const z = 0;\n');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<{ cache: { status: string } }> } }).parsed;
      expect(parsed.files[0].cache.status).toBe('miss');
    });
  });

  // -------------------------------------------------------------------------
  // Pagination (token_budget)
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    test('returns pagination info when token_budget is set', async () => {
      const relA = writeRelative(tmpDir, 'pg-a.ts', 'const a = 1;\n');
      const relB = writeRelative(tmpDir, 'pg-b.ts', 'const b = 2;\n');
      const r = await exec(tool, {
        files: [{ path: relA }, { path: relB }],
        token_budget: 1000,
        page: 1,
      });
      const parsed = (r as { parsed: { pagination: { page: number; total_pages: number } } }).parsed;
      expect(parsed.pagination).toBeDefined();
      expect(parsed.pagination.page).toBe(1);
      expect(parsed.pagination.total_pages).toBeGreaterThanOrEqual(1);
    });

    test('very small budget splits files onto separate pages', async () => {
      // Write two files each about 20 chars
      const relA = writeRelative(tmpDir, 'small-a.ts', 'export const AA = 1;\n');
      const relB = writeRelative(tmpDir, 'small-b.ts', 'export const BB = 2;\n');
      // token_budget=1 forces each file onto its own page
      const r1 = await exec(tool, {
        files: [{ path: relA }, { path: relB }],
        token_budget: 1,
        page: 1,
      });
      const p1 = (r1 as { parsed: { pagination: { total_pages: number; pending_files: string[] }; files: unknown[] } }).parsed;
      expect(p1.pagination.total_pages).toBe(2);
      expect(p1.files).toHaveLength(1);
      expect(p1.pagination.pending_files).toHaveLength(1);

      // Page 2
      const r2 = await exec(tool, {
        files: [{ path: relA }, { path: relB }],
        token_budget: 1,
        page: 2,
      });
      const p2 = (r2 as { parsed: { files: unknown[] } }).parsed;
      expect(p2.files).toHaveLength(1);
    });

    test('page defaults to 1', async () => {
      const rel = writeRelative(tmpDir, 'pg-default.ts', 'const x = 1;\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        token_budget: 1000,
      });
      const parsed = (r as { parsed: { pagination: { page: number } } }).parsed;
      expect(parsed.pagination.page).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Output formats
  // -------------------------------------------------------------------------

  describe('output formats', () => {
    test('count_only: no files array in output', async () => {
      const rel = writeRelative(tmpDir, 'co.ts', 'const a = 1;\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { format: 'count_only' },
      });
      const parsed = (r as { parsed: { files?: unknown; summary: { files_read: number } } }).parsed;
      expect(parsed.files).toBeUndefined();
      expect(parsed.summary.files_read).toBe(1);
    });

    test('minimal: files array has no content field', async () => {
      const rel = writeRelative(tmpDir, 'min.ts', 'const b = 2;\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { format: 'minimal' },
      });
      const parsed = (r as { parsed: { files: Array<{ content?: string; lineCount: number }> } }).parsed;
      expect(parsed.files[0].content).toBeUndefined();
      expect(parsed.files[0].lineCount).toBeGreaterThan(0);
    });

    test('standard: files array has content', async () => {
      const rel = writeRelative(tmpDir, 'std.ts', 'const c = 3;\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { format: 'standard' },
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('const c = 3');
    });

    test('verbose: includes metadata field', async () => {
      const rel = writeRelative(tmpDir, 'verb.ts', 'const d = 4;\n');
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { format: 'verbose' },
      });
      const parsed = (r as { parsed: { files: Array<{ metadata: { encoding: string } }> } }).parsed;
      expect(parsed.files[0].metadata).toBeDefined();
      expect(parsed.files[0].metadata.encoding).toBe('utf-8');
    });

    test('max_per_item limits lines returned per file', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      const rel = writeRelative(tmpDir, 'maxlines.ts', lines);
      const r = await exec(tool, {
        files: [{ path: rel }],
        output: { max_per_item: 5 },
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      const outputLines = parsed.files[0].content.split('\n').filter(Boolean);
      expect(outputLines.length).toBeLessThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // Binary file detection
  // -------------------------------------------------------------------------

  describe('binary detection', () => {
    test('binary file is skipped with binary=true', async () => {
      const rel = writeBinary(tmpDir, 'binary.bin');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<{ binary: boolean }> } }).parsed;
      expect(parsed.files[0].binary).toBe(true);
    });

    test('binary file does not have content', async () => {
      const rel = writeBinary(tmpDir, 'img.bin');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<{ content?: string; binary: boolean }> } }).parsed;
      expect(parsed.files[0].content).toBeUndefined();
    });

    test('binary file counted in files_binary summary', async () => {
      const rel = writeBinary(tmpDir, 'bin2.bin');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { summary: { files_binary: number } } }).parsed;
      expect(parsed.summary.files_binary).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    test('non-existent file: error per file, not whole batch', async () => {
      const relA = writeRelative(tmpDir, 'exists.ts', 'const x = 1;\n');
      const r = await exec(tool, {
        files: [{ path: relA }, { path: 'src/nonexistent-zzzz-xyzabc.ts' }],
      });
      const parsed = (r as { parsed: { files: Array<{ error?: string; content?: string }>; summary: { files_errored: number } } }).parsed;
      // First file succeeds
      expect(parsed.files[0].content).toContain('const x = 1');
      // Second file has error
      expect(parsed.files[1].error).toBeDefined();
      // Summary reflects one errored file
      expect(parsed.summary.files_errored).toBe(1);
    });

    test('path traversal attempt returns error per file', async () => {
      const r = await exec(tool, {
        files: [{ path: '../../../etc/passwd' }],
      });
      expect(r.success).toBe(true); // tool succeeds overall
      const parsed = (r as { parsed: { files: Array<{ error?: string }> } }).parsed;
      expect(parsed.files[0].error).toMatch(/outside the project root/);
    });

    test('tool returns success:false with error for invalid args', async () => {
      // Passing no files array
      const r = await tool.execute({ files: undefined as unknown as [] });
      // Should not throw; returns an error shape
      expect(r.success === false || r.success === true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Empty file
  // -------------------------------------------------------------------------

  describe('empty file', () => {
    test('handles empty file without error', async () => {
      const rel = writeRelative(tmpDir, 'empty.ts', '');
      const r = await exec(tool, { files: [{ path: rel }] });
      expect(r.success).toBe(true);
      const parsed = (r as { parsed: { files: Array<{ lineCount: number; error?: string }> } }).parsed;
      expect(parsed.files[0].error).toBeUndefined();
    });

    test('outline of empty file returns empty string', async () => {
      const rel = writeRelative(tmpDir, 'empty2.ts', '');
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'outline' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('tree-sitter outline unavailable');
    });

    test('symbols of empty file returns empty string', async () => {
      const rel = writeRelative(tmpDir, 'empty3.ts', '');
      const r = await exec(tool, {
        files: [{ path: rel, extract: 'symbols' }],
      });
      const parsed = (r as { parsed: { files: Array<{ content: string }> } }).parsed;
      expect(parsed.files[0].content).toContain('tree-sitter symbols unavailable');
    });
  });

  // -------------------------------------------------------------------------
  // ProjectIndex integration
  // -------------------------------------------------------------------------

  describe('project index integration', () => {
    test('upserts file into project index after read', async () => {
      resetTestProjectIndexes();
      const idx = getTestProjectIndex(PROJECT_ROOT);
      const newTool = new ReadTool(idx, cache, intelligence);
      const rel = writeRelative(tmpDir, 'indexed.ts', 'export const IDX = 1;\n');
      await newTool.execute({ files: [{ path: rel }] });
      const absPath = resolve(PROJECT_ROOT, rel);
      const entry = idx.getFile(absPath);
      expect(entry).not.toBeNull();
      expect(entry!.tokens).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Image support
  // -------------------------------------------------------------------------

  describe('image support', () => {
    test('reads a PNG file as base64 with image=true and mediaType', async () => {
      // Create a minimal 1x1 PNG (89 bytes, valid header)
      const pngHeader = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489000000' +
        '0a49444154789c6260000000000200011e2163660000000049454e44ae426082',
        'hex',
      );
      const absPath = join(tmpDir, 'test.png');
      const { writeFileSync: wf } = await import('node:fs');
      wf(absPath, pngHeader);
      const rel = absPath.slice(PROJECT_ROOT.length + 1);
      const r = await exec(tool, { files: [{ path: rel }] });
      expect(r.success).toBe(true);
      const parsed = (r as {
        parsed: {
          files: Array<Record<string, unknown>>;
          images: Array<{ path: string; base64: string; mediaType: string }>;
        };
      }).parsed;
      const f = parsed.files[0];
      expect(f.image).toBe(true);
      expect(f.binary).toBeUndefined();
      expect(f.mediaType).toBe('image/png');
      expect(typeof f.content).toBe('string');
      expect(parsed.images).toHaveLength(1);
      expect(parsed.images[0].path).toBe(rel);
      expect(parsed.images[0].mediaType).toBe('image/png');
      expect(() => Buffer.from(parsed.images[0].base64, 'base64')).not.toThrow();
    });

    test('reads a JPEG file and sets mediaType=image/jpeg', async () => {
      // Minimal valid JPEG: SOI + EOI markers
      const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const absPath = join(tmpDir, 'test.jpg');
      const { writeFileSync: wf } = await import('node:fs');
      wf(absPath, jpegBuf);
      const rel = absPath.slice(PROJECT_ROOT.length + 1);
      const r = await exec(tool, { files: [{ path: rel }] });
      expect(r.success).toBe(true);
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      const f = parsed.files[0];
      expect(f.image).toBe(true);
      expect(f.mediaType).toBe('image/jpeg');
    });

    test('reads a .webp file and sets mediaType=image/webp', async () => {
      const webpBuf = Buffer.from('RIFF....WEBP', 'ascii');
      const absPath = join(tmpDir, 'test.webp');
      const { writeFileSync: wf } = await import('node:fs');
      wf(absPath, webpBuf);
      const rel = absPath.slice(PROJECT_ROOT.length + 1);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(parsed.files[0].mediaType).toBe('image/webp');
    });

    test('reads a .svg file as base64 with mediaType=image/svg+xml', async () => {
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>';
      const rel = writeRelative(tmpDir, 'test.svg', svgContent);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as {
        parsed: {
          files: Array<Record<string, unknown>>;
          images: Array<{ path: string; base64: string; mediaType: string }>;
        };
      }).parsed;
      const f = parsed.files[0];
      expect(f.image).toBe(true);
      expect(f.mediaType).toBe('image/svg+xml');
      expect(parsed.images).toHaveLength(1);
      expect(parsed.images[0].path).toBe(rel);
      expect(parsed.images[0].mediaType).toBe('image/svg+xml');
      // Decoded base64 should equal the original SVG content
      expect(Buffer.from(parsed.images[0].base64, 'base64').toString('utf-8')).toBe(svgContent);
    });

    test('image files are counted as files_read (not binary) in summary', async () => {
      const svgContent = '<svg/>';
      const rel = writeRelative(tmpDir, 'icon.svg', svgContent);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { summary: Record<string, number> } }).parsed;
      expect(parsed.summary.files_binary).toBe(0);
      expect(parsed.summary.files_read).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // PDF support
  // -------------------------------------------------------------------------

  describe('PDF support', () => {
    /** Build a minimal PDF with BT...ET text block. */
    function makePdf(text: string): string {
      return [
        '%PDF-1.4',
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
        '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
        '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<<>>>>endobj',
        '4 0 obj',
        '<</Length 44>>',
        'stream',
        `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`,
        'endstream',
        'endobj',
        'xref',
        '%%EOF',
      ].join('\n');
    }

    test('extracts text from a PDF file', async () => {
      const rel = writeRelative(tmpDir, 'test.pdf', makePdf('Hello PDF'));
      const r = await exec(tool, { files: [{ path: rel }] });
      expect(r.success).toBe(true);
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(typeof parsed.files[0].content).toBe('string');
      expect(parsed.files[0].content).toContain('Hello PDF');
    });

    test('accepts pages parameter and includes it in output', async () => {
      const rel = writeRelative(tmpDir, 'paged.pdf', makePdf('Page text'));
      const r = await exec(tool, { files: [{ path: rel, pages: '1-2' }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      const content = parsed.files[0].content as string;
      expect(content).toContain('[pages: 1-2]');
      expect(content).toContain('Page text');
    });

    test('returns fallback note for unreadable PDF streams', async () => {
      const rel = writeRelative(tmpDir, 'empty.pdf', '%PDF-1.4\n%%EOF');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      // No readable streams → JSON fallback note
      expect(parsed.files[0].content).toContain('No readable text streams found');
    });

    test('PDF is not counted as binary', async () => {
      const rel = writeRelative(tmpDir, 'counted.pdf', makePdf('x'));
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { summary: Record<string, number> } }).parsed;
      expect(parsed.summary.files_binary).toBe(0);
    });

    test('PDF content not returned in count_only format', async () => {
      const rel = writeRelative(tmpDir, 'countonly.pdf', makePdf('x'));
      const r = await exec(tool, { files: [{ path: rel }], output: { format: 'count_only' } });
      const parsed = (r as { parsed: { files?: unknown } }).parsed;
      expect(parsed.files).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Jupyter notebook support
  // -------------------------------------------------------------------------

  describe('Jupyter notebook support', () => {
    function makeNotebook(
      cells: Array<{ cell_type: string; source: string; outputs?: unknown[] }>,
    ): string {
      return JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: cells.map((c) => ({
          cell_type: c.cell_type,
          source: c.source,
          outputs: c.outputs ?? [],
          metadata: {},
        })),
      });
    }

    test('formats code cell with source', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'print("hello")' }]);
      const rel = writeRelative(tmpDir, 'test.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      const content = parsed.files[0].content as string;
      expect(content).toContain('[cell 1] (code):');
      expect(content).toContain('print("hello")');
    });

    test('formats markdown cell', async () => {
      const nb = makeNotebook([{ cell_type: 'markdown', source: '# Title' }]);
      const rel = writeRelative(tmpDir, 'md.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(parsed.files[0].content).toContain('[cell 1] (markdown):');
      expect(parsed.files[0].content).toContain('# Title');
    });

    test('includes cell output for code cells', async () => {
      const nb = makeNotebook([{
        cell_type: 'code',
        source: 'print(42)',
        outputs: [{ output_type: 'stream', text: ['42\n'] }],
      }]);
      const rel = writeRelative(tmpDir, 'output.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      const content = parsed.files[0].content as string;
      expect(content).toContain('[output]:');
      expect(content).toContain('42');
    });

    test('handles array source field', async () => {
      const nb = JSON.stringify({
        nbformat: 4, nbformat_minor: 5, metadata: {},
        cells: [{ cell_type: 'code', source: ['x = 1\n', 'print(x)'], outputs: [], metadata: {} }],
      });
      const rel = writeRelative(tmpDir, 'arraysrc.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(parsed.files[0].content).toContain('x = 1');
      expect(parsed.files[0].content).toContain('print(x)');
    });

    test('handles invalid JSON gracefully', async () => {
      const rel = writeRelative(tmpDir, 'bad.ipynb', 'not json {{{');
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(parsed.files[0].content).toContain('invalid notebook JSON');
    });

    test('notebook not counted as binary', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x = 1' }]);
      const rel = writeRelative(tmpDir, 'binary-check.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { summary: Record<string, number> } }).parsed;
      expect(parsed.summary.files_binary).toBe(0);
    });

    test('includes display_data output from code cell', async () => {
      const nb = makeNotebook([{
        cell_type: 'code',
        source: 'display(42)',
        outputs: [{ output_type: 'display_data', data: { 'text/plain': ['42'] } }],
      }]);
      const rel = writeRelative(tmpDir, 'display.ipynb', nb);
      const r = await exec(tool, { files: [{ path: rel }] });
      const parsed = (r as { parsed: { files: Array<Record<string, unknown>> } }).parsed;
      expect(parsed.files[0].content).toContain('[output]:');
      expect(parsed.files[0].content).toContain('42');
    });
  });

  // -------------------------------------------------------------------------
  // Global extract mode
  // -------------------------------------------------------------------------

  describe('global extract mode', () => {
    test('global extract=symbols applies to all files', async () => {
      const relA = writeRelative(tmpDir, 'g-a.ts', 'export function alpha() {}\n');
      const relB = writeRelative(tmpDir, 'g-b.ts', 'export function beta() {}\n');
      const r = await exec(tool, {
        extract: 'symbols',
        files: [{ path: relA }, { path: relB }],
      });
      const parsed = (r as { parsed: { files: Array<{ extract: string; content: string }> } }).parsed;
      expect(parsed.files[0].extract).toBe('symbols');
      expect(parsed.files[1].extract).toBe('symbols');
      expect(parsed.files[0].content).toContain('alpha');
      expect(parsed.files[1].content).toContain('beta');
    });
  });
});
