import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { createEditTool } from '../../tools/edit/index.ts';
import { FileStateCache } from '../../state/file-cache.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd();

let tmpCounter = 0;

function makeTmpDir(): string {
  const dir = join(PROJECT_ROOT, `.test-edit-nb-tmp-${process.pid}-${++tmpCounter}`);
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
  return absPath.slice(PROJECT_ROOT.length + 1);
}

/** Build a minimal valid Jupyter notebook JSON string. */
function makeNotebook(
  cells: Array<{
    cell_type: 'code' | 'markdown' | 'raw';
    source: string | string[];
    id?: string;
    outputs?: unknown[];
    execution_count?: number | null;
  }>,
  opts: { nbformat?: number; nbformat_minor?: number } = {},
): string {
  const nbformat = opts.nbformat ?? 4;
  const nbformat_minor = opts.nbformat_minor ?? 5;
  const notebook = {
    nbformat,
    nbformat_minor,
    metadata: {},
    cells: cells.map((c) => {
      const cell: Record<string, unknown> = {
        cell_type: c.cell_type,
        source: Array.isArray(c.source) ? c.source : [c.source],
        metadata: {},
      };
      if (c.id) cell['id'] = c.id;
      if (c.cell_type === 'code') {
        cell['outputs'] = c.outputs ?? [];
        cell['execution_count'] = c.execution_count ?? null;
      }
      return cell;
    }),
  };
  return JSON.stringify(notebook, null, 1) + '\n';
}

function parseNotebook(content: string) {
  return JSON.parse(content) as {
    cells: Array<{
      cell_type: string;
      source: string | string[];
      id?: string;
      outputs?: unknown[];
      execution_count?: number | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('edit tool — notebook operations', () => {
  let tmpDir: string;
  let fileCache: FileStateCache;
  let tool: ReturnType<typeof createEditTool>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fileCache = new FileStateCache();
    tool = createEditTool(fileCache, { cwd: PROJECT_ROOT });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // normalizeSource
  // -------------------------------------------------------------------------

  describe('normalizeSource (via replace)', () => {
    test('string source is split into line array with preserved newlines', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'old line' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'line one\nline two' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      // normalizeSource splits on '\n' and appends '\n' to all but last
      expect(parsed.cells[0].source).toEqual(['line one\n', 'line two']);
    });

    test('array source is preserved as-is', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'old' }]);
      const file = writeFile(tmpDir, 'nb2.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb2.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: ['already\n', 'array'] }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].source).toEqual(['already\n', 'array']);
    });
  });

  // -------------------------------------------------------------------------
  // validateNotebook
  // -------------------------------------------------------------------------

  describe('validateNotebook', () => {
    test('rejects notebook missing nbformat', async () => {
      const bad = JSON.stringify({ cells: [] }) + '\n';
      const file = writeFile(tmpDir, 'bad.ipynb', bad);
      fileCache.update(join(tmpDir, 'bad.ipynb'), bad);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'x' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a valid jupyter notebook/i);
    });

    test('rejects notebook missing cells array', async () => {
      const bad = JSON.stringify({ nbformat: 4 }) + '\n';
      const file = writeFile(tmpDir, 'bad2.ipynb', bad);
      fileCache.update(join(tmpDir, 'bad2.ipynb'), bad);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a valid jupyter notebook/i);
    });

    test('rejects notebook where a cell is missing source field', async () => {
      const bad =
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [{ cell_type: 'code', metadata: {} }],
        }) + '\n';
      const file = writeFile(tmpDir, 'bad3.ipynb', bad);
      fileCache.update(join(tmpDir, 'bad3.ipynb'), bad);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a valid jupyter notebook/i);
    });

    test('rejects notebook where a cell is missing cell_type', async () => {
      const bad =
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [{ source: 'hi', metadata: {} }],
        }) + '\n';
      const file = writeFile(tmpDir, 'bad4.ipynb', bad);
      fileCache.update(join(tmpDir, 'bad4.ipynb'), bad);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not a valid jupyter notebook/i);
    });
  });

  // -------------------------------------------------------------------------
  // Runtime input validation
  // -------------------------------------------------------------------------

  describe('runtime input validation', () => {
    test('error when neither edits nor notebook_operations provided', async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/edits or notebook_operations/i);
    });

    test('error when operations is not an array', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: 'not-an-array' as unknown as [],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/operations must be an array/i);
    });

    test('error when path is missing', async () => {
      const result = await tool.execute({
        notebook_operations: {
          path: '',
          operations: [],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/path is required/i);
    });
  });

  // -------------------------------------------------------------------------
  // Replace cell by index
  // -------------------------------------------------------------------------

  describe('replace cell by index', () => {
    test('replaces source of cell at index 0', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'old code' },
        { cell_type: 'markdown', source: 'text' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'new code' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].source).toEqual(['new code']);
      expect(parsed.cells[1].source).toEqual(['text']); // unchanged
    });

    test('replaces source of cell at index 1', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'first' },
        { cell_type: 'code', source: 'second' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 1, source: 'replaced' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[1].source).toEqual(['replaced']);
    });
  });

  // -------------------------------------------------------------------------
  // Replace cell by cell_id
  // -------------------------------------------------------------------------

  describe('replace cell by cell_id', () => {
    test('replaces cell identified by id field', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'original', id: 'cell-abc' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell_id: 'cell-abc', source: 'updated' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].source).toEqual(['updated']);
    });

    test('returns error for unknown cell_id', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x', id: 'abc' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell_id: 'does-not-exist', source: 'y' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cell_id.*not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Replace with cell_type change
  // -------------------------------------------------------------------------

  describe('replace with cell_type change', () => {
    test('code -> markdown: removes outputs and execution_count', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', text: 'hi' }], execution_count: 5 },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: '# heading', cell_type: 'markdown' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].cell_type).toBe('markdown');
      expect(parsed.cells[0].outputs).toBeUndefined();
      expect(parsed.cells[0].execution_count).toBeUndefined();
    });

    test('markdown -> code: adds outputs and execution_count', async () => {
      const nb = makeNotebook([{ cell_type: 'markdown', source: '# heading' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'print(1)', cell_type: 'code' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].cell_type).toBe('code');
      expect(parsed.cells[0].outputs).toEqual([]);
      expect(parsed.cells[0].execution_count).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Replace with clear_outputs
  // -------------------------------------------------------------------------

  describe('replace with clear_outputs', () => {
    test('clears outputs and execution_count on code cell', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', text: 'hello' }], execution_count: 3 },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'x', clear_outputs: true }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells[0].outputs).toEqual([]);
      expect(parsed.cells[0].execution_count).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  describe('insert cell', () => {
    test('insert at beginning (after: -1)', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'existing' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', after: -1, cell_type: 'markdown', source: 'intro' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(2);
      expect(parsed.cells[0].source).toEqual(['intro']);
      expect(parsed.cells[1].source).toEqual(['existing']);
    });

    test('insert at middle position (after: 0)', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'first' },
        { cell_type: 'code', source: 'third' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', after: 0, cell_type: 'markdown', source: 'second' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(3);
      expect(parsed.cells[1].source).toEqual(['second']);
    });

    test('insert at end (no after specified)', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'first' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', cell_type: 'code', source: 'last' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(2);
      expect(parsed.cells[1].source).toEqual(['last']);
    });

    test('insert after cell_id', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'before', id: 'ref-cell' },
        { cell_type: 'code', source: 'after' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', cell_id: 'ref-cell', cell_type: 'markdown', source: 'middle' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(3);
      expect(parsed.cells[1].source).toEqual(['middle']);
    });

    test('insert: after index out of bounds returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'only' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', after: 10, cell_type: 'code', source: 'x' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of bounds/i);
    });

    test('insert: missing source returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'insert', cell_type: 'code' } as unknown as { op: 'insert'; cell_type: 'code'; source: string }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/source is required/i);
    });
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  describe('delete cell', () => {
    test('delete by index', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'keep' },
        { cell_type: 'code', source: 'remove' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'delete', cell: 1 }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(1);
      expect(parsed.cells[0].source).toEqual(['keep']);
    });

    test('delete by cell_id', async () => {
      const nb = makeNotebook([
        { cell_type: 'code', source: 'keep' },
        { cell_type: 'code', source: 'remove', id: 'del-me' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'delete', cell_id: 'del-me' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(1);
    });

    test('delete: out-of-range index returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'only' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'delete', cell: 5 }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of range/i);
    });

    test('delete: cell_id not found returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x', id: 'real-id' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'delete', cell_id: 'ghost-id' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/cell_id.*not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed batch: insert + delete with indexOffset correctness
  // -------------------------------------------------------------------------

  describe('mixed batch operations', () => {
    test('insert then delete with correct indexOffset', async () => {
      // Start: [A, B, C]. Insert after 0 => [A, NEW, B, C] (indexOffset=+1).
      // Delete cell: 2 (original index) with indexOffset=+1 => actual index 3 => deletes C.
      // Result: [A, NEW, B].
      const nb = makeNotebook([
        { cell_type: 'code', source: 'A' },
        { cell_type: 'code', source: 'B' },
        { cell_type: 'code', source: 'C' },
      ]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [
            { op: 'insert', after: 0, cell_type: 'markdown', source: 'NEW' },
            { op: 'delete', cell: 2 }, // original index 2 (C), indexOffset=+1 => adjusted 3
          ],
        },
      });
      expect(result.success).toBe(true);
      const parsed = parseNotebook(readFileSync(file, 'utf-8'));
      expect(parsed.cells).toHaveLength(3);
      expect(parsed.cells[0].source).toEqual(['A']);
      expect(parsed.cells[1].source).toEqual(['NEW']);
      expect(parsed.cells[2].source).toEqual(['B']);
    });
  });

  // -------------------------------------------------------------------------
  // OCC conflict detection
  // -------------------------------------------------------------------------

  describe('OCC conflict detection', () => {
    test('rejects operation when file was externally modified', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      // Update cache with old content
      fileCache.update(join(tmpDir, 'nb.ipynb'), 'old content hash marker');
      // Write different content to disk (simulating external modification)
      writeFileSync(file, nb, 'utf-8');
      // The cache now shows the file as potentially modified since content changed
      // We need to mark as modified by having cache see different content
      // Actually the cache uses content hash - let's just prime with different content
      const freshCache = new FileStateCache();
      freshCache.update(join(tmpDir, 'nb.ipynb'), 'different content than on disk');
      const toolWithFreshCache = createEditTool(freshCache, { cwd: PROJECT_ROOT });

      const result = await toolWithFreshCache.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'new' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/OCC conflict/i);
    });
  });

  // -------------------------------------------------------------------------
  // Error: replace missing source
  // -------------------------------------------------------------------------

  describe('error cases', () => {
    test('replace: missing source returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0 } as unknown as { op: 'replace'; cell: number; source: string }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/source is required/i);
    });

    test('replace: out-of-range index returns error', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 99, source: 'y' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/out of range/i);
    });
  });

  // -------------------------------------------------------------------------
  // dry_run: operations computed but file not modified
  // -------------------------------------------------------------------------

  describe('dry_run', () => {
    test('dry_run: reports operations without writing to disk', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'original' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);
      const originalContent = readFileSync(file, 'utf-8');

      const result = await tool.execute({
        dry_run: true,
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'new content' }],
        },
      });
      expect(result.success).toBe(true);
      // Output should indicate dry run
      expect(result.output).toMatch(/dry run/i);
      // File should NOT be modified
      expect(readFileSync(file, 'utf-8')).toBe(originalContent);
    });

    test('dry_run: count_only format includes dry_run: true', async () => {
      const nb = makeNotebook([{ cell_type: 'code', source: 'x' }]);
      const file = writeFile(tmpDir, 'nb.ipynb', nb);
      fileCache.update(join(tmpDir, 'nb.ipynb'), nb);

      const result = await tool.execute({
        dry_run: true,
        output: { format: 'count_only' },
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'new' }],
        },
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output!);
      expect(parsed.dry_run).toBe(true);
      expect(parsed.applied).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // File not .ipynb
  // -------------------------------------------------------------------------

  describe('non-notebook file', () => {
    test('returns error for non-ipynb file', async () => {
      const file = writeFile(tmpDir, 'script.py', 'print(1)\n');

      const result = await tool.execute({
        notebook_operations: {
          path: relPath(file),
          operations: [{ op: 'replace', cell: 0, source: 'x' }],
        },
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/\.ipynb/i);
    });
  });
});
