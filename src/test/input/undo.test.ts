/**
 * undo.test.ts, undo/redo coalescing, cursor restoration, kill/yank undoability,
 * bounded history eviction, and redo invalidation.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  saveUndoState,
  undoPromptState,
  redoPromptState,
  shouldCoalesceUndo,
  UNDO_COALESCE_MS,
  type UndoState,
} from '../../input/handler-prompt-buffer.ts';

// ---------------------------------------------------------------------------
// shouldCoalesceUndo
// ---------------------------------------------------------------------------

describe('shouldCoalesceUndo()', () => {
  const now = Date.now();

  test('coalesces when both kinds are text and within window', () => {
    expect(shouldCoalesceUndo('text', 'text', now - 100, now)).toBe(true);
  });

  test('does NOT coalesce when last kind is kill', () => {
    expect(shouldCoalesceUndo('kill', 'text', now - 100, now)).toBe(false);
  });

  test('does NOT coalesce when incoming kind is kill', () => {
    expect(shouldCoalesceUndo('text', 'kill', now - 100, now)).toBe(false);
  });

  test('does NOT coalesce when incoming kind is yank', () => {
    expect(shouldCoalesceUndo('text', 'yank', now - 100, now)).toBe(false);
  });

  test('does NOT coalesce when incoming kind is other', () => {
    expect(shouldCoalesceUndo('text', 'other', now - 100, now)).toBe(false);
  });

  test('does NOT coalesce when delta exceeds UNDO_COALESCE_MS', () => {
    expect(shouldCoalesceUndo('text', 'text', now - UNDO_COALESCE_MS - 1, now)).toBe(false);
  });

  test('coalesces at the exact boundary (delta === UNDO_COALESCE_MS - 1)', () => {
    expect(shouldCoalesceUndo('text', 'text', now - (UNDO_COALESCE_MS - 1), now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveUndoState / undoPromptState / redoPromptState
// ---------------------------------------------------------------------------

describe('saveUndoState / undoPromptState', () => {
  let undoStack: UndoState[];
  let redoStack: UndoState[];
  const MAX = 100;

  beforeEach(() => {
    undoStack = [];
    redoStack = [];
  });

  test('snapshot is pushed onto undo stack', () => {
    saveUndoState(undoStack, redoStack, 'hello', 5, MAX);
    expect(undoStack.length).toBe(1);
    expect(undoStack[0]).toEqual({ prompt: 'hello', cursorPos: 5 });
  });

  test('saveUndoState clears the redo stack', () => {
    redoStack.push({ prompt: 'old', cursorPos: 0 });
    saveUndoState(undoStack, redoStack, 'new', 3, MAX);
    expect(redoStack.length).toBe(0);
  });

  test('undoPromptState returns null when stack is empty', () => {
    expect(undoPromptState(undoStack, redoStack, 'x', 0)).toBeNull();
  });

  test('undoPromptState restores previous text and cursor', () => {
    saveUndoState(undoStack, redoStack, 'before', 2, MAX);
    const result = undoPromptState(undoStack, redoStack, 'after', 5);
    expect(result).toEqual({ prompt: 'before', cursorPos: 2 });
  });

  test('undoPromptState pushes current state onto redo stack', () => {
    saveUndoState(undoStack, redoStack, 'before', 2, MAX);
    undoPromptState(undoStack, redoStack, 'after', 5);
    expect(redoStack.length).toBe(1);
    expect(redoStack[0]).toEqual({ prompt: 'after', cursorPos: 5 });
  });
});

describe('redoPromptState', () => {
  let undoStack: UndoState[];
  let redoStack: UndoState[];
  const MAX = 100;

  beforeEach(() => {
    undoStack = [];
    redoStack = [];
  });

  test('returns null when redo stack is empty', () => {
    expect(redoPromptState(undoStack, redoStack, 'x', 0)).toBeNull();
  });

  test('redoPromptState pops from redo and pushes current onto undo', () => {
    saveUndoState(undoStack, redoStack, 'before', 0, MAX);
    undoPromptState(undoStack, redoStack, 'after', 4);
    // Now redo stack has 'after'; undo the undo
    const result = redoPromptState(undoStack, redoStack, 'before', 0);
    expect(result).toEqual({ prompt: 'after', cursorPos: 4 });
  });

  test('new edit invalidates redo stack (saveUndoState clears redo)', () => {
    saveUndoState(undoStack, redoStack, 'state1', 0, MAX);
    undoPromptState(undoStack, redoStack, 'state2', 6);
    // redo stack now has state2; simulate new edit
    saveUndoState(undoStack, redoStack, 'state1', 0, MAX);
    expect(redoStack.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded history eviction (MAX_UNDO groups)
// ---------------------------------------------------------------------------

describe('bounded undo history', () => {
  const MAX = 10;

  test('retains exactly MAX_UNDO groups when limit is hit', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    for (let i = 0; i < MAX + 5; i++) {
      saveUndoState(undoStack, redoStack, `state${i}`, i, MAX);
    }
    expect(undoStack.length).toBe(MAX);
  });

  test('oldest entry is evicted when capacity exceeded', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    for (let i = 0; i < MAX + 1; i++) {
      saveUndoState(undoStack, redoStack, `s${i}`, i, MAX);
    }
    // Oldest (s0) is evicted; first remaining entry is s1
    expect(undoStack[0]).toEqual({ prompt: 's1', cursorPos: 1 });
    // Most recent at top is s(MAX)
    expect(undoStack[undoStack.length - 1]).toEqual({ prompt: `s${MAX}`, cursorPos: MAX });
  });
});

// ---------------------------------------------------------------------------
// Kill-then-undo (kill is undoable)
// ---------------------------------------------------------------------------

describe('kill-then-undo', () => {
  const MAX = 100;

  test('kill pushes undo snapshot; undo restores pre-kill state', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];

    // State before kill: 'hello world', cursor at 5
    saveUndoState(undoStack, redoStack, 'hello world', 5, MAX);
    // After kill-line: 'hello', cursor at 5 (killed ' world')
    const result = undoPromptState(undoStack, redoStack, 'hello', 5);
    expect(result).toEqual({ prompt: 'hello world', cursorPos: 5 });
  });

  test('yank is undoable (saveUndoState before yank)', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];

    // Pre-yank state
    saveUndoState(undoStack, redoStack, 'abc', 3, MAX);
    // After yank: 'abcworld', cursor at 8
    const result = undoPromptState(undoStack, redoStack, 'abcworld', 8);
    expect(result).toEqual({ prompt: 'abc', cursorPos: 3 });
  });
});

// ---------------------------------------------------------------------------
// Cursor restoration on undo
// ---------------------------------------------------------------------------

describe('cursor restoration', () => {
  const MAX = 100;

  test('undo restores both prompt AND cursor position', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    saveUndoState(undoStack, redoStack, 'abc', 1, MAX);
    const result = undoPromptState(undoStack, redoStack, 'abcd', 4);
    expect(result?.prompt).toBe('abc');
    expect(result?.cursorPos).toBe(1);
  });

  test('redo restores both prompt AND cursor position', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    saveUndoState(undoStack, redoStack, 'abc', 1, MAX);
    undoPromptState(undoStack, redoStack, 'abcd', 4);
    const result = redoPromptState(undoStack, redoStack, 'abc', 1);
    expect(result?.prompt).toBe('abcd');
    expect(result?.cursorPos).toBe(4);
  });
});
