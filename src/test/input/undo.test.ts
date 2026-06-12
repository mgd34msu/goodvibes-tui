/**
 * undo.test.ts — undo/redo coalescing, cursor restoration, kill/yank undoability,
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
// Coalescing burst groups — simulate what saveUndoStateForText does
// ---------------------------------------------------------------------------

describe('coalescing burst simulation', () => {
  const MAX = 100;

  /**
   * Simulate the saveUndoStateForText logic inline:
   * - If last kind was 'text' AND within UNDO_COALESCE_MS, skip snapshot.
   * - Otherwise push a snapshot and update lastKind/lastMs.
   */
  function simulateSaveForText(
    undoStack: UndoState[],
    redoStack: UndoState[],
    prompt: string,
    cursorPos: number,
    lastKind: 'text' | 'other',
    lastMs: number,
    nowMs: number,
  ): { lastKind: 'text' | 'other'; lastMs: number } {
    if (shouldCoalesceUndo(lastKind, 'text', lastMs, nowMs)) {
      return { lastKind: 'text', lastMs: nowMs };
    }
    saveUndoState(undoStack, redoStack, prompt, cursorPos, MAX);
    return { lastKind: 'text', lastMs: nowMs };
  }

  test('burst of text insertions coalesces into one undo group', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    const base = 1000;
    let state = { lastKind: 'other' as 'text' | 'other', lastMs: 0 };

    // Snapshot the pre-typing state manually (first char is always a new group)
    state = simulateSaveForText(undoStack, redoStack, '', 0, state.lastKind, state.lastMs, base);
    state = simulateSaveForText(undoStack, redoStack, 'h', 1, state.lastKind, state.lastMs, base + 50);
    state = simulateSaveForText(undoStack, redoStack, 'he', 2, state.lastKind, state.lastMs, base + 100);
    state = simulateSaveForText(undoStack, redoStack, 'hel', 3, state.lastKind, state.lastMs, base + 150);

    // All within UNDO_COALESCE_MS (500ms): only the first character generates a snapshot
    expect(undoStack.length).toBe(1);
    expect(undoStack[0]).toEqual({ prompt: '', cursorPos: 0 });
  });

  test('burst breaks when delta exceeds UNDO_COALESCE_MS', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    const base = 1000;
    let state = { lastKind: 'other' as 'text' | 'other', lastMs: 0 };

    // First group: snapshot '' at base, coalesce 'hi' at base+100
    state = simulateSaveForText(undoStack, redoStack, '', 0, state.lastKind, state.lastMs, base);
    state = simulateSaveForText(undoStack, redoStack, 'hi', 2, state.lastKind, state.lastMs, base + 100);

    // Long pause relative to last edit (base+100): wait past UNDO_COALESCE_MS after last edit
    // so delta from lastMs(base+100) to now must be > UNDO_COALESCE_MS.
    // NOTE: Like the real handler, we pass the PRE-insertion state to simulateSaveForText
    // (the snapshot is taken before the new character is inserted).
    const afterPause = base + 100 + UNDO_COALESCE_MS + 10;
    state = simulateSaveForText(undoStack, redoStack, 'hi', 2, state.lastKind, state.lastMs, afterPause);
    state = simulateSaveForText(undoStack, redoStack, 'hi ', 3, state.lastKind, state.lastMs, afterPause + 50);

    // Two groups: snapshot '' (pre-first-char) and snapshot 'hi' (pre-space, after pause)
    expect(undoStack.length).toBe(2);
    expect(undoStack[0]).toEqual({ prompt: '', cursorPos: 0 });
    expect(undoStack[1]).toEqual({ prompt: 'hi', cursorPos: 2 });
  });

  test('cursor move breaks coalescing group (simulated via lastKind reset)', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    const base = 1000;
    let state = { lastKind: 'other' as 'text' | 'other', lastMs: 0 };

    // Type first group
    state = simulateSaveForText(undoStack, redoStack, '', 0, state.lastKind, state.lastMs, base);
    state = simulateSaveForText(undoStack, redoStack, 'ab', 2, state.lastKind, state.lastMs, base + 50);
    // Cursor move breaks coalesce (sets lastKind to 'other')
    state = { lastKind: 'other', lastMs: state.lastMs };
    // Type again shortly after
    state = simulateSaveForText(undoStack, redoStack, 'abc', 3, state.lastKind, state.lastMs, base + 100);

    // 2 groups: snapshot '' (first keystroke) + snapshot 'abc' (after cursor break)
    // Note: 'ab' was coalesced into the first group and never pushed; the cursor
    // move resets lastKind to 'other', so the very next text save pushes the
    // current buffer state ('abc') as a new group.
    expect(undoStack.length).toBe(2);
    expect(undoStack[1]).toEqual({ prompt: 'abc', cursorPos: 3 });
  });

  test('kill operation breaks coalescing group', () => {
    const undoStack: UndoState[] = [];
    const redoStack: UndoState[] = [];
    const base = 1000;
    let state = { lastKind: 'other' as 'text' | 'other', lastMs: 0 };

    // Type first group
    state = simulateSaveForText(undoStack, redoStack, '', 0, state.lastKind, state.lastMs, base);
    // Kill op: unconditional saveUndoState, then kind is 'other'
    saveUndoState(undoStack, redoStack, 'hello', 5, MAX);
    state = { lastKind: 'other', lastMs: base + 100 };
    // Next text after kill always starts new group
    state = simulateSaveForText(undoStack, redoStack, '', 0, state.lastKind, state.lastMs, base + 150);

    // 3 groups: '' (first text push) + 'hello' (kill unconditional push) + '' (post-kill text push)
    // The kill unconditional push adds a second entry; the subsequent text save
    // starts a new group because lastKind was reset to 'other' after the kill.
    expect(undoStack.length).toBe(3);
    expect(undoStack[1]).toEqual({ prompt: 'hello', cursorPos: 5 });
    expect(undoStack[2]).toEqual({ prompt: '', cursorPos: 0 });
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
