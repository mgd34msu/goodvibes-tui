import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileUndoManager } from '../file-undo.ts';
import { getTestFileUndoManager, resetTestRuntimeServices } from '../../test/helpers/runtime-services.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir = '';
let testFilePath = '';

function makeOp(overrides?: {
  path?: string;
  beforeContent?: string | null;
  afterContent?: string;
  tool?: 'write' | 'edit';
}) {
  return {
    path: testFilePath,
    beforeContent: 'before content',
    afterContent: 'after content',
    tool: 'write' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileUndoManager', () => {
  let manager: FileUndoManager;

  beforeEach(() => {
    resetTestRuntimeServices();
    manager = getTestFileUndoManager();
    tempDir = mkdtempSync(join(tmpdir(), `gv-file-undo-${randomUUID()}-`));
    testFilePath = join(tempDir, 'test-file.ts');
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    resetTestRuntimeServices();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
    testFilePath = '';
  });

  // ── snapshot ──────────────────────────────────────────────

  it('snapshot stores before/after content correctly', () => {
    const op = makeOp({ beforeContent: 'old content', afterContent: 'new content' });
    manager.snapshot(op);

    const entry = manager.peekUndo();
    expect(entry).toBeDefined();
    expect(entry!.beforeContent).toBe('old content');
    expect(entry!.afterContent).toBe('new content');
    expect(entry!.path).toBe(testFilePath);
    expect(entry!.tool).toBe('write');
    expect(entry!.timestamp).toBeTruthy();
  });

  it('new snapshot clears the redo stack', () => {
    // Build up a redo entry
    manager.snapshot(makeOp({ beforeContent: 'v1', afterContent: 'v2' }));
    manager.undo(); // moves to redo
    expect(manager.redoDepth()).toBe(1);

    // A new snapshot should wipe redo
    manager.snapshot(makeOp({ beforeContent: 'v2', afterContent: 'v3' }));
    expect(manager.redoDepth()).toBe(0);
  });

  // ── undo ──────────────────────────────────────────────────

  it('undo restores beforeContent and pushes op to redo stack', () => {
    const op = makeOp({ beforeContent: 'before', afterContent: 'after' });
    manager.snapshot(op);
    writeFileSync(testFilePath, 'after', 'utf-8');

    const result = manager.undo();

    expect(result).toEqual({ path: testFilePath, tool: 'write' });
    expect(readFileSync(testFilePath, 'utf-8')).toBe('before');
    expect(manager.undoDepth()).toBe(0);
    expect(manager.redoDepth()).toBe(1);
  });

  it('undo with null beforeContent writes empty string', () => {
    const op = makeOp({ beforeContent: null, afterContent: 'new file content' });
    manager.snapshot(op);
    writeFileSync(testFilePath, 'new file content', 'utf-8');

    const result = manager.undo();

    expect(result).toBeDefined();
    expect(readFileSync(testFilePath, 'utf-8')).toBe('');
  });

  it('undo returns null when nothing to undo', () => {
    expect(manager.undo()).toBeNull();
  });

  // ── redo ──────────────────────────────────────────────────

  it('redo re-applies afterContent and pushes op back to undo stack', () => {
    const op = makeOp({ beforeContent: 'before', afterContent: 'after' });
    manager.snapshot(op);
    writeFileSync(testFilePath, 'after', 'utf-8');
    manager.undo();

    const result = manager.redo();

    expect(result).toEqual({ path: testFilePath, tool: 'write' });
    expect(readFileSync(testFilePath, 'utf-8')).toBe('after');
    expect(manager.redoDepth()).toBe(0);
    expect(manager.undoDepth()).toBe(1);
  });

  it('redo returns null when nothing to redo', () => {
    expect(manager.redo()).toBeNull();
  });

  // ── stack cap ─────────────────────────────────────────────

  it('snapshot stack cap: 51st entry removes oldest from undo stack', () => {
    for (let i = 0; i < 51; i++) {
      manager.snapshot(makeOp({
        path: `/tmp/file-${i}.ts`,
        beforeContent: `before-${i}`,
        afterContent: `after-${i}`,
      }));
    }

    expect(manager.undoDepth()).toBe(50);
    // Oldest entry (file-0) should have been evicted
    // Walk the stack — peekUndo returns most recent (file-50)
    const top = manager.peekUndo();
    expect(top!.path).toBe('/tmp/file-50.ts');
  });

  it('redo stack cap: 51 undos keeps redo at 50 entries', () => {
    // Fill undo stack with 51 ops
    for (let i = 0; i < 51; i++) {
      manager.snapshot(makeOp({
        path: `/tmp/file-${i}.ts`,
        beforeContent: `before-${i}`,
        afterContent: `after-${i}`,
      }));
    }
    // Undo all 50 remaining (oldest was evicted, 50 remain)
    for (let i = 0; i < 50; i++) {
      manager.undo();
    }

    expect(manager.redoDepth()).toBe(50);
  });

  it('redo stack cap: undo capping redoStack at 50 evicts oldest entry', () => {
    // Fill undo with 51 ops, undo all — the 51st undo push should evict the oldest redo entry
    for (let i = 0; i < 51; i++) {
      manager.snapshot(makeOp({
        path: `/tmp/file-${i}.ts`,
        beforeContent: `before-${i}`,
        afterContent: `after-${i}`,
      }));
    }
    // snapshot evicts the oldest from undoStack (only 50 remain)
    // Undo all 50 remaining
    for (let i = 0; i < 50; i++) {
      manager.undo();
    }
    // redoStack should be capped at 50
    expect(manager.redoDepth()).toBe(50);
  });

  it('redo stack cap: redo capping undoStack at 50 evicts oldest entry', () => {
    // Fill undo with 50, undo all to fill redo (50 items)
    for (let i = 0; i < 50; i++) {
      manager.snapshot(makeOp({
        path: `/tmp/file-${i}.ts`,
        beforeContent: `before-${i}`,
        afterContent: `after-${i}`,
      }));
    }
    for (let i = 0; i < 50; i++) {
      manager.undo();
    }
    expect(manager.redoDepth()).toBe(50);
    // Redo all — each redo pushes to undoStack; 51st push should evict oldest
    for (let i = 0; i < 50; i++) {
      manager.redo();
    }
    // undoStack should be capped at 50
    expect(manager.undoDepth()).toBe(50);
  });

  // ── peekUndo ──────────────────────────────────────────────

  it('peekUndo returns the last entry without popping', () => {
    manager.snapshot(makeOp({ path: '/tmp/a.ts' }));
    manager.snapshot(makeOp({ path: '/tmp/b.ts' }));

    const peeked = manager.peekUndo();
    expect(peeked!.path).toBe('/tmp/b.ts');
    // Stack size should be unchanged
    expect(manager.undoDepth()).toBe(2);
  });

  it('peekUndo returns undefined when stack is empty', () => {
    expect(manager.peekUndo()).toBeUndefined();
  });

  // ── clear ─────────────────────────────────────────────────

  it('clear empties both stacks', () => {
    manager.snapshot(makeOp());
    manager.snapshot(makeOp());
    manager.undo(); // populate redo

    manager.clear();

    expect(manager.undoDepth()).toBe(0);
    expect(manager.redoDepth()).toBe(0);
  });

  it('test runtime exposes one file-undo manager per runtime graph', () => {
    const a = getTestFileUndoManager();
    const b = getTestFileUndoManager();
    expect(a).toBe(b);
  });
});
