import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import { AutocompleteEngine } from '../../input/autocomplete.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import type { UndoState } from '../../input/handler-prompt-buffer.ts';
import { InputHistory } from '../../input/input-history.ts';

type InputHandlerTestAccess = {
  undoStack: UndoState[];
  redoStack: UndoState[];
  saveUndoState(): void;
  handleUndo(): void;
  handleRedo(): void;
  findPathToken(): { start: number; prefix: string } | null;
  handlePathCompletion(): boolean;
  commandRegistry: CommandRegistry | null;
  autocomplete: AutocompleteEngine | null;
};

function asTestAccess(input: InputHandler): InputHandlerTestAccess {
  return input as unknown as InputHandlerTestAccess;
}

function makeInput(): InputHandler {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
  ih.setContentWidth(80);
  return ih;
}

// Access private members for unit testing
function getUndoStack(ih: InputHandler): UndoState[] {
  return asTestAccess(ih).undoStack;
}
function getRedoStack(ih: InputHandler): UndoState[] {
  return asTestAccess(ih).redoStack;
}
function saveUndo(ih: InputHandler): void {
  asTestAccess(ih).saveUndoState();
}
function doUndo(ih: InputHandler): void {
  asTestAccess(ih).handleUndo();
}
function doRedo(ih: InputHandler): void {
  asTestAccess(ih).handleRedo();
}
function findPathToken(ih: InputHandler): { start: number; prefix: string } | null {
  return asTestAccess(ih).findPathToken();
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
    asTestAccess(ih).redoStack.push({ prompt: 'old', cursorPos: 3 });
    ih.prompt = 'step2';
    ih.cursorPos = 5;
    saveUndo(ih);
    expect(getRedoStack(ih).length).toBe(0);
  });

  test('undo stack bounded at MAX_UNDO (100)', () => {
    const ih = makeInput();
    const MAX = 100;
    for (let i = 0; i <= MAX; i++) {
      ih.prompt = `state${i}`;
      ih.cursorPos = i;
      saveUndo(ih);
    }
    expect(getUndoStack(ih).length).toBe(MAX);
  });
});

describe('feed render ordering', () => {
  test('render callbacks observe the committed prompt state for typed text', () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    const renders: string[] = [];
    let input!: InputHandler;
    input = new InputHandler(
      () => {
        renders.push(input.prompt);
      },
      sel,
      () => 0,
      () => 20,
      () => history,
      () => {},
      () => {},
      createDefaultUiRuntimeServices(),
    );
    input.setContentWidth(80);

    input.feed('a');

    expect(input.prompt).toBe('a');
    expect(renders.at(-1)).toBe('a');
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
    const MAX = 100;
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
    const result = asTestAccess(ih).handlePathCompletion();
    expect(result).toBe(false);
  });

  test('completes a path token when allFiles has matches', () => {
    const ih = makeInput();
    ih.prompt = '@src/in';
    ih.cursorPos = 7;
    // Inject test files directly
    ih.filePicker.allFiles = ['src/input/handler.ts', 'src/input/file-picker.ts', 'src/runtime/events/index.ts'];
    const result = asTestAccess(ih).handlePathCompletion();
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
    asTestAccess(ih).handlePathCompletion();
    const first = ih.prompt;

    // Second Tab: cursor is now after completed path, start should still be 0
    asTestAccess(ih).handlePathCompletion();
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
    asTestAccess(ih).handlePathCompletion();
    // Undo stack should contain the state before completion
    const stack = getUndoStack(ih);
    expect(stack.length).toBeGreaterThanOrEqual(1);
    expect(stack[stack.length - 1].prompt).toBe(beforePrompt);
  });
});

// ── command-mode arrow key navigation ─────────────────────────────────────────

describe('command-mode arrow key navigation', () => {
  test('left/right arrow keys move the cursor while in command mode', () => {
    const ih = makeInput();
    ih.commandMode = true;
    ih.prompt = '/plan';
    ih.cursorPos = 5;

    ih.feed('\x1b[D'); // left arrow
    expect(ih.cursorPos).toBe(4);

    ih.feed('\x1b[C'); // right arrow
    expect(ih.cursorPos).toBe(5);
  });

  test('up/down arrow keys are consumed in command mode (cursor unchanged)', () => {
    const ih = makeInput();
    ih.commandMode = true;
    ih.prompt = '/plan';
    ih.cursorPos = 5;

    const before = ih.cursorPos;
    ih.feed('\x1b[A'); // up arrow
    ih.feed('\x1b[B'); // down arrow
    expect(ih.cursorPos).toBe(before);
  });
});

// ── multiline prompt/history arrow navigation ───────────────────────────────

describe('multiline prompt history navigation', () => {
  test('up arrow moves within a multiline current prompt before recalling history', () => {
    const ih = makeInput();
    const history = new InputHistory({ historyPath: '/tmp/gv-unused-history.json', persist: false });
    history.add('previous command');
    ih.setHistory(history);
    ih.prompt = 'one\ntwo\nthree';
    ih.cursorPos = ih.prompt.length;

    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('one\ntwo\nthree');
    expect(ih.cursorPos).toBe(7);

    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('one\ntwo\nthree');
    expect(ih.cursorPos).toBe(4);

    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('one\ntwo\nthree');
    expect(ih.cursorPos).toBe(0);

    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('previous command');
    expect(ih.cursorPos).toBe('previous command'.length);
  });

  test('down arrow moves within a multiline recalled history item before navigating forward', () => {
    const ih = makeInput();
    const history = new InputHistory({ historyPath: '/tmp/gv-unused-history.json', persist: false });
    history.add('older command');
    history.add('line1\nline2\nline3');
    history.add('newer command');
    ih.setHistory(history);

    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('newer command');
    ih.feed('\x1b[A');
    expect(ih.prompt).toBe('line1\nline2\nline3');
    expect(ih.cursorPos).toBe(17);

    ih.feed('\x1b[A');
    ih.feed('\x1b[A');
    expect(ih.cursorPos).toBe(6);

    ih.feed('\x1b[B');
    expect(ih.prompt).toBe('line1\nline2\nline3');
    expect(ih.cursorPos).toBe(12);

    ih.feed('\x1b[B');
    expect(ih.prompt).toBe('newer command');
    expect(ih.cursorPos).toBe('newer command'.length);
  });
});

// ── autocomplete reset on space ─────────────────────────────────────────────

describe('autocomplete reset on space in command mode', () => {
  test('typing space after /plan hides autocomplete', () => {
    const ih = makeInput();
    // Wire up a minimal CommandRegistry + AutocompleteEngine
    const registry = new CommandRegistry();
    registry.register({ name: 'plan', description: 'Run plan', handler: () => {} });
    asTestAccess(ih).commandRegistry = registry;
    asTestAccess(ih).autocomplete = new AutocompleteEngine(registry);

    // Simulate having typed '/plan' — autocomplete is active
    ih.commandMode = true;
    ih.prompt = '/plan';
    ih.cursorPos = 5;
    // Manually update autocomplete so it has results
    asTestAccess(ih).autocomplete?.update('plan');
    expect(asTestAccess(ih).autocomplete?.isActive).toBe(true);

    // Feed a space character — should reset autocomplete
    ih.feed(' ');

    // Autocomplete should no longer be active after space
    expect(asTestAccess(ih).autocomplete?.isActive).toBe(false);
    // commandMode stays true (space doesn't exit command mode)
    expect(ih.commandMode).toBe(true);
    // Prompt should contain the space
    expect(ih.prompt).toBe('/plan ');
  });

  test('autocomplete stays active while typing command name without space', () => {
    const ih = makeInput();
    const registry = new CommandRegistry();
    registry.register({ name: 'plan', description: 'Run plan', handler: () => {} });
    asTestAccess(ih).commandRegistry = registry;
    asTestAccess(ih).autocomplete = new AutocompleteEngine(registry);

    // Simulate typing '/pla' — autocomplete should update but stay active
    ih.commandMode = true;
    ih.prompt = '/pla';
    ih.cursorPos = 4;
    asTestAccess(ih).autocomplete?.update('pla');
    expect(asTestAccess(ih).autocomplete?.isActive).toBe(true);

    // Feed 'n' — no space, autocomplete should remain active
    ih.feed('n');

    // Autocomplete should still be active (no space typed)
    expect(asTestAccess(ih).autocomplete?.isActive).toBe(true);
  });
});
