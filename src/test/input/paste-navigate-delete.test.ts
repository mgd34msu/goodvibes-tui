import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@pellux/goodvibes-terminal-shell';
import { InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { registerPaste } from '../../input/handler-content-actions.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

function makeInput(contentWidth = 40): InputHandler {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
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

  test('backspace at marker start removes entire marker', () => {
    const ih = makeInput(CW);
    // Type some text before the marker
    insertText(ih, 'before ');
    // Register a multi-line paste with >8 lines (creates a TEXT marker)
    const marker = ih.registerPaste('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9');
    // Insert the marker text into the prompt at cursor
    ih.prompt = ih.prompt.slice(0, ih.cursorPos) + marker + ih.prompt.slice(ih.cursorPos);
    ih.cursorPos += marker.length;
    insertText(ih, ' after');

    const promptWithMarker = ih.prompt;
    const markerStart = promptWithMarker.indexOf('[TEXT:');
    expect(markerStart).toBeGreaterThanOrEqual(0);

    // Position cursor exactly at the START of the marker (simulates left-arrow jump)
    ih.cursorPos = markerStart;

    // Feed backspace — handler should detect marker.start === cursorPos and delete entire marker
    ih.feed('\x7f');

    // The entire marker should be gone, not just one character
    expect(ih.prompt).not.toContain('[TEXT:');
    // The surrounding text should remain intact
    expect(ih.prompt).toContain('before');
    expect(ih.prompt).toContain('after');
    // Prompt should be shorter by the full marker length, not just 1 char
    const markerLen = marker.length;
    expect(ih.prompt.length).toBe(promptWithMarker.length - markerLen);
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

describe('Bracketed paste line-ending normalization', () => {
  const CW = 40;

  // Terminals (xterm, tmux, kitty, iTerm2, alacritty) transmit the line
  // breaks inside a bracketed paste as \r — the same byte Enter sends — and
  // external clipboards can carry \r\n. Without normalization those bytes
  // land in the prompt string verbatim: split('\n') sees a single line (the
  // composer never grows, registerPaste never counts lines) and the \r cells
  // reach the terminal as control bytes that return the cursor to column 0
  // mid-row, overwriting the prompt marker.

  test('bracketed paste with CR separators lands as \\n and grows the composer', () => {
    const ih = makeInput(CW);
    ih.feed('\x1b[200~line one\rline two\rline three\x1b[201~');
    expect(ih.prompt).toBe('line one\nline two\nline three');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(3);
  });

  test('bracketed paste with CRLF separators lands as \\n', () => {
    const ih = makeInput(CW);
    ih.feed('\x1b[200~alpha\r\nbeta\r\ngamma\x1b[201~');
    expect(ih.prompt).toBe('alpha\nbeta\ngamma');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(3);
  });

  test('nine CR-separated lines register as a [TEXT:] marker with a true line count', () => {
    const ih = makeInput(CW);
    const paste = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\r');
    ih.feed(`\x1b[200~${paste}\x1b[201~`);
    expect(ih.prompt).toMatch(/^\[TEXT: p\d+, 9 lines\]$/);
  });

  test('registerPaste stores registry content with \\n line endings', () => {
    const state = {
      nextImageId: 0,
      nextPasteId: 0,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
    };
    const content = Array.from({ length: 9 }, (_, i) => `l${i}`).join('\r\n');
    const { marker } = registerPaste(state, content, '/tmp');
    expect(marker).toBe('[TEXT: p0, 9 lines]');
    expect(state.pasteRegistry.get('p0')).toBe(Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n'));
  });

  test('binary image paste keeps raw bytes (PNG magic contains \\r\\n)', () => {
    const state = {
      nextImageId: 0,
      nextPasteId: 0,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
    };
    const png = '\x89PNG\r\n\x1a\n' + 'x'.repeat(200);
    const { marker } = registerPaste(state, png, '/tmp');
    expect(marker.startsWith('[IMAGE:')).toBe(true);
    expect(state.imageRegistry.get('img0')!.data).toBe(Buffer.from(png, 'binary').toString('base64'));
  });

  test('short CR-separated paste keeps editing consistent (backspace joins lines)', () => {
    const ih = makeInput(CW);
    ih.feed('\x1b[200~one\rtwo\x1b[201~');
    expect(ih.prompt).toBe('one\ntwo');
    // Cursor sits at the end; backspace twice removes 'o' then 'w'
    ih.feed('\x7f');
    ih.feed('\x7f');
    expect(ih.prompt).toBe('one\nt');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(2);
  });

});
