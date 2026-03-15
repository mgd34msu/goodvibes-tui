import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { EventBus } from '../../core/event-bus.ts';
import { SelectionManager } from '../../input/selection.ts';

function makeInput(): InputHandler {
  const bus = new EventBus();
  const sel = new SelectionManager();
  const ih = new InputHandler(bus, sel, () => 0, () => 20, () => ({
    getLineCount: () => 0, getAllLines: () => [], getSnapshot: () => [],
    addLine: () => {}, addLines: () => {}, clear: () => {},
  }) as any, () => {}, () => {});
  ih.setContentWidth(80);
  return ih;
}

// Access private members for unit testing
function getUndoStack(ih: InputHandler): Array<{ prompt: string; cursorPos: number }> {
  return (ih as any).undoStack;
}
function getRedoStack(ih: InputHandler): Array<{ prompt: string; cursorPos: number }> {
  return (ih as any).redoStack;
}
function saveUndo(ih: InputHandler): void {
  (ih as any).saveUndoState();
}
function doUndo(ih: InputHandler): void {
  (ih as any).handleUndo();
}
function doRedo(ih: InputHandler): void {
  (ih as any).handleRedo();
}
function findPathToken(ih: InputHandler): { start: number; prefix: string } | null {
  return (ih as any).findPathToken();
}

// ── saveUndoState ──────────────────────────────────────────────────────────

describe('saveUndoState', () => {
  test('captures current prompt and cursor onto the undo stack', () => {
    const ih = makeInput();
    ih.prompt = 'hello';
    ih.cursorPos = 5;
    saveUndo(ih);
    const stack = getUndoStack(ih);
    expect(stack.length).toBe(1);
    expect(stack[0].prompt).toBe('hello');
    expect(stack[0].cursorPos).toBe(5);
  });

  test('clears the redo stack on each save', () => {
    const ih = makeInput();
    ih.prompt = 'step1';
    ih.cursorPos = 5;
    saveUndo(ih);
    // Manually put something in redo to simulate prior undo
    (ih as any).redoStack.push({ prompt: 'old', cursorPos: 3 });
    ih.prompt = 'step2';
    ih.cursorPos = 5;
    saveUndo(ih);
    expect(getRedoStack(ih).length).toBe(0);
  });

  test('undo stack bounded at MAX_UNDO (50)', () => {
    const ih = makeInput();
    const MAX = (InputHandler as any).MAX_UNDO as number;
    for (let i = 0; i <= MAX; i++) {
      ih.prompt = `state${i}`;
      ih.cursorPos = i;
      saveUndo(ih);
    }
    expect(getUndoStack(ih).length).toBe(MAX);
  });
});

// ── handleUndo ─────────────────────────────────────────────────────────────

describe('handleUndo', () => {
  test('restores the previous prompt and cursor state', () => {
    const ih = makeInput();
    ih.prompt = 'before';
    ih.cursorPos = 6;
    saveUndo(ih);
    ih.prompt = 'after';
    ih.cursorPos = 5;
    doUndo(ih);
    expect(ih.prompt).toBe('before');
    expect(ih.cursorPos).toBe(6);
  });

  test('pushes current state to redo stack before restoring', () => {
    const ih = makeInput();
    ih.prompt = 'v1';
    ih.cursorPos = 2;
    saveUndo(ih);
    ih.prompt = 'v2';
    ih.cursorPos = 2;
    doUndo(ih);
    const redo = getRedoStack(ih);
    expect(redo.length).toBe(1);
    expect(redo[0].prompt).toBe('v2');
  });

  test('does nothing when undo stack is empty', () => {
    const ih = makeInput();
    ih.prompt = 'current';
    ih.cursorPos = 7;
    doUndo(ih);
    expect(ih.prompt).toBe('current');
    expect(ih.cursorPos).toBe(7);
  });

  test('redo stack bounded at MAX_UNDO after many undos', () => {
    const ih = makeInput();
    const MAX = (InputHandler as any).MAX_UNDO as number;
    // Build a large undo stack
    for (let i = 0; i <= MAX + 5; i++) {
      ih.prompt = `s${i}`;
      ih.cursorPos = i;
      saveUndo(ih);
    }
    // Now undo MAX+1 times — redo stack should be bounded
    for (let i = 0; i < MAX + 1; i++) {
      doUndo(ih);
    }
    expect(getRedoStack(ih).length).toBeLessThanOrEqual(MAX);
  });
});

// ── handleRedo ─────────────────────────────────────────────────────────────

describe('handleRedo', () => {
  test('restores the undone state', () => {
    const ih = makeInput();
    ih.prompt = 'v1';
    ih.cursorPos = 2;
    saveUndo(ih);
    ih.prompt = 'v2';
    ih.cursorPos = 2;
    doUndo(ih);
    doRedo(ih);
    expect(ih.prompt).toBe('v2');
    expect(ih.cursorPos).toBe(2);
  });

  test('does nothing when redo stack is empty', () => {
    const ih = makeInput();
    ih.prompt = 'current';
    ih.cursorPos = 7;
    doRedo(ih);
    expect(ih.prompt).toBe('current');
    expect(ih.cursorPos).toBe(7);
  });

  test('redo stack is cleared on new edit after undo', () => {
    const ih = makeInput();
    ih.prompt = 'v1';
    ih.cursorPos = 2;
    saveUndo(ih);
    ih.prompt = 'v2';
    ih.cursorPos = 2;
    doUndo(ih);
    // Simulate new edit: saveUndo clears redo stack
    ih.prompt = 'v3';
    ih.cursorPos = 2;
    saveUndo(ih);
    expect(getRedoStack(ih).length).toBe(0);
  });
});

// ── findPathToken ───────────────────────────────────────────────────────────

describe('findPathToken', () => {
  test('detects @path token', () => {
    const ih = makeInput();
    ih.prompt = 'open @src/in';
    ih.cursorPos = 12;
    const result = findPathToken(ih);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('src/in');
    expect(result!.start).toBe(5);
  });

  test('detects !@path token (inject mode)', () => {
    const ih = makeInput();
    ih.prompt = '!@src/utils';
    ih.cursorPos = 11;
    const result = findPathToken(ih);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('src/utils');
    expect(result!.start).toBe(0);
  });

  test('detects bare path with slash', () => {
    const ih = makeInput();
    ih.prompt = 'see src/core/foo';
    ih.cursorPos = 16;
    const result = findPathToken(ih);
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('src/core/foo');
  });

  test('returns null for a plain word without path marker', () => {
    const ih = makeInput();
    ih.prompt = 'hello';
    ih.cursorPos = 5;
    const result = findPathToken(ih);
    expect(result).toBeNull();
  });

  test('returns null for empty cursor position', () => {
    const ih = makeInput();
    ih.prompt = '';
    ih.cursorPos = 0;
    const result = findPathToken(ih);
    expect(result).toBeNull();
  });
});

// ── handlePathCompletion (via public state) ─────────────────────────────────

describe('handlePathCompletion', () => {
  test('returns false when allFiles is empty', () => {
    const ih = makeInput();
    ih.prompt = '@src/in';
    ih.cursorPos = 7;
    // filePicker.allFiles is [] by default
    const result = (ih as any).handlePathCompletion() as boolean;
    expect(result).toBe(false);
  });

  test('completes a path token when allFiles has matches', () => {
    const ih = makeInput();
    ih.prompt = '@src/in';
    ih.cursorPos = 7;
    // Inject test files directly
    ih.filePicker.allFiles = ['src/input/handler.ts', 'src/input/file-picker.ts', 'src/core/event-bus.ts'];
    const result = (ih as any).handlePathCompletion() as boolean;
    expect(result).toBe(true);
    // Prompt should now contain @src/input/... 
    expect(ih.prompt.startsWith('@src/input/')).toBe(true);
  });

  test('cycles to next match on repeated Tab (start position tracking)', () => {
    const ih = makeInput();
    ih.prompt = '@src/in';
    ih.cursorPos = 7;
    ih.filePicker.allFiles = ['src/input/handler.ts', 'src/input/file-picker.ts'];

    // First Tab
    (ih as any).handlePathCompletion();
    const first = ih.prompt;

    // Second Tab: cursor is now after completed path, start should still be 0
    (ih as any).handlePathCompletion();
    const second = ih.prompt;

    // Both should be valid completions but different from each other
    expect(first).not.toBe(second);
    expect(first.startsWith('@src/input/')).toBe(true);
    expect(second.startsWith('@src/input/')).toBe(true);
  });

  test('saves undo state before mutating prompt', () => {
    const ih = makeInput();
    ih.prompt = '@src/in';
    ih.cursorPos = 7;
    ih.filePicker.allFiles = ['src/input/handler.ts'];
    const beforePrompt = ih.prompt;
    (ih as any).handlePathCompletion();
    // Undo stack should contain the state before completion
    const stack = getUndoStack(ih);
    expect(stack.length).toBeGreaterThanOrEqual(1);
    expect(stack[stack.length - 1].prompt).toBe(beforePrompt);
  });
});
