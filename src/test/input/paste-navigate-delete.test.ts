import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { EventBus } from '../../core/event-bus.ts';
import { SelectionManager } from '../../input/selection.ts';

function makeInput(contentWidth = 40): InputHandler {
  const bus = new EventBus();
  const sel = new SelectionManager();
  const ih = new InputHandler(bus, sel, () => 0, () => 20, () => ({
    getLineCount: () => 0, getAllLines: () => [], getSnapshot: () => [],
    addLine: () => {}, addLines: () => {}, clear: () => {},
  }) as any, () => {}, () => {});
  ih.setContentWidth(contentWidth);
  return ih;
}

/** Simulate typing/pasting text at cursor */
function insertText(ih: InputHandler, text: string) {
  ih.prompt = ih.prompt.slice(0, ih.cursorPos) + text + ih.prompt.slice(ih.cursorPos);
  ih.cursorPos += text.length;
  ih.ensureInputCursorVisible();
}

/** Simulate backspace */
function backspace(ih: InputHandler) {
  if (ih.cursorPos > 0) {
    ih.prompt = ih.prompt.slice(0, ih.cursorPos - 1) + ih.prompt.slice(ih.cursorPos);
    ih.cursorPos--;
  }
}

/** Simulate delete */
function del(ih: InputHandler) {
  if (ih.cursorPos < ih.prompt.length) {
    ih.prompt = ih.prompt.slice(0, ih.cursorPos) + ih.prompt.slice(ih.cursorPos + 1);
  }
}

/** Verify cursor visual matches actual character */
function verifyCursor(ih: InputHandler, cw: number, label: string) {
  const info = ih.getWrappedPromptInfo(cw);
  const seg = info.segments[info.cursorWrappedLine];
  const visualChar = info.wrappedLines[info.cursorWrappedLine]?.[info.cursorCol];
  const actualChar = ih.prompt[ih.cursorPos];

  // At end of prompt, both should be undefined
  if (ih.cursorPos >= ih.prompt.length) {
    expect(info.cursorCol).toBeLessThanOrEqual(seg?.length ?? 0);
    return;
  }

  // At end of segment (col === length), cursor is past visible text — that's valid
  if (info.cursorCol === seg?.length) return;

  // When cursor is on a \n or consumed space, visual shows the next line's char — that's correct
  if (actualChar === '\n' || actualChar === undefined) return;

  // Otherwise visual and actual must match
  if (visualChar !== actualChar) {
    throw new Error(`${label}: DESYNC visual=${JSON.stringify(visualChar)} actual=${JSON.stringify(actualChar)} pos=${ih.cursorPos} line=${info.cursorWrappedLine} col=${info.cursorCol}`);
  }
}

describe('Paste + Navigate + Delete/Backspace', () => {
  const CW = 40;

  test('multiline paste with newlines, navigate up, backspace at each position', () => {
    const ih = makeInput(CW);
    const paste = 'Line one of paste\nLine two of paste\nLine three of paste\nLine four';
    insertText(ih, paste);

    // Navigate up 2 lines
    for (let i = 0; i < 2; i++) {
      const info = ih.getWrappedPromptInfo(CW);
      const target = info.cursorWrappedLine - 1;
      if (target >= 0) {
        const col = Math.min(info.cursorCol, info.segments[target].length);
        ih.cursorPos = info.segments[target].rawStart + col;
      }
    }

    // Backspace 10 times, verify cursor consistency each time
    for (let i = 0; i < 10; i++) {
      verifyCursor(ih, CW, `backspace-${i}`);
      backspace(ih);
    }
    verifyCursor(ih, CW, 'after-backspaces');
  });

  test('paste exceeding content width, navigate left through wrap, backspace', () => {
    const ih = makeInput(30);
    const paste = 'This is a long line that will definitely wrap around the content area multiple times';
    insertText(ih, paste);

    // Navigate left 20 chars (through wrap boundaries)
    for (let i = 0; i < 20; i++) {
      ih.cursorPos = Math.max(0, ih.cursorPos - 1);
    }

    verifyCursor(ih, 30, 'after-left-nav');

    // Backspace 5 times
    for (let i = 0; i < 5; i++) {
      const beforeLen = ih.prompt.length;
      backspace(ih);
      expect(ih.prompt.length).toBe(beforeLen - 1);
      verifyCursor(ih, 30, `bs-${i}`);
    }
  });

  test('paste multiline with lines exceeding width, navigate and delete', () => {
    const ih = makeInput(25);
    const paste = 'Short\nThis line is longer than twenty five characters wide\nAnother short\nYet another long line that exceeds the width';
    insertText(ih, paste);

    // Navigate to middle of the long wrapped line
    ih.cursorPos = 35;
    verifyCursor(ih, 25, 'at-pos-35');

    // Delete forward 5 times
    for (let i = 0; i < 5; i++) {
      const beforeLen = ih.prompt.length;
      del(ih);
      if (ih.cursorPos < ih.prompt.length + 1) {
        expect(ih.prompt.length).toBe(beforeLen - 1);
      }
      verifyCursor(ih, 25, `del-${i}`);
    }

    // Navigate up 2 lines and backspace
    for (let i = 0; i < 2; i++) {
      const info = ih.getWrappedPromptInfo(25);
      const target = info.cursorWrappedLine - 1;
      if (target >= 0) {
        const col = Math.min(info.cursorCol, info.segments[target].length);
        ih.cursorPos = info.segments[target].rawStart + col;
      }
    }

    verifyCursor(ih, 25, 'after-up-nav');
    backspace(ih);
    verifyCursor(ih, 25, 'final-backspace');
  });

  test('multiple pastes then navigate between them', () => {
    const ih = makeInput(CW);

    // First paste
    insertText(ih, 'First paste line one\nFirst paste line two');
    // Second paste
    insertText(ih, '\nSecond paste starts here\nAnd continues');
    // Third paste
    insertText(ih, '\nThird paste\nWith multiple\nLines inside');

    // Navigate to various positions and verify
    for (let pos = 0; pos <= ih.prompt.length; pos += 7) {
      ih.cursorPos = Math.min(pos, ih.prompt.length);
      verifyCursor(ih, CW, `scan-pos-${pos}`);
    }

    // Navigate up from bottom to top
    ih.cursorPos = ih.prompt.length;
    let lineCount = ih.getWrappedPromptInfo(CW).wrappedLines.length;
    for (let i = 0; i < lineCount; i++) {
      const info = ih.getWrappedPromptInfo(CW);
      const target = info.cursorWrappedLine - 1;
      if (target >= 0) {
        const col = Math.min(info.cursorCol, info.segments[target].length);
        ih.cursorPos = info.segments[target].rawStart + col;
      }
      verifyCursor(ih, CW, `up-${i}`);
    }
  });

  test('backspace at newline joins lines', () => {
    const ih = makeInput(CW);
    insertText(ih, 'line one\nline two');

    // Navigate to start of "line two" (position 9)
    ih.cursorPos = 9;
    const info = ih.getWrappedPromptInfo(CW);
    expect(info.cursorWrappedLine).toBe(1);
    expect(info.cursorCol).toBe(0);

    // Backspace should delete the \n and join lines
    backspace(ih);
    expect(ih.prompt).toBe('line oneline two');
    expect(ih.cursorPos).toBe(8);
  });

  test('cursor position survives full edit cycle', () => {
    const ih = makeInput(35);

    // Paste, navigate, type, delete, navigate, backspace
    insertText(ih, 'Hello world this is a test of the editing system');
    ih.cursorPos = 20; // middle
    verifyCursor(ih, 35, 'mid');

    // Type some text at cursor
    insertText(ih, ' INSERTED ');
    verifyCursor(ih, 35, 'after-insert');

    // Delete forward
    del(ih); del(ih); del(ih);
    verifyCursor(ih, 35, 'after-del');

    // Backspace
    backspace(ih); backspace(ih);
    verifyCursor(ih, 35, 'after-bs');

    // Navigate up
    const info = ih.getWrappedPromptInfo(35);
    if (info.cursorWrappedLine > 0) {
      const target = info.cursorWrappedLine - 1;
      const col = Math.min(info.cursorCol, info.segments[target].length);
      ih.cursorPos = info.segments[target].rawStart + col;
    }
    verifyCursor(ih, 35, 'after-up');

    backspace(ih);
    verifyCursor(ih, 35, 'final');
  });
});
