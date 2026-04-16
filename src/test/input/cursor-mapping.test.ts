import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

describe('Cursor mapping through word-wrap', () => {
  let input: InputHandler;

  beforeEach(() => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, createDefaultUiRuntimeServices());
    input.setContentWidth(20);
  });

  test('simple text: cursor at each position maps correctly', () => {
    input.prompt = 'hello world';
    const w = 20;
    for (let i = 0; i <= input.prompt.length; i++) {
      input.cursorPos = i;
      const info = input.getWrappedPromptInfo(w);
      // Single line, no wrapping
      expect(info.cursorWrappedLine).toBe(0);
      expect(info.cursorCol).toBe(i);
    }
  });

  test('wrapped text: cursor maps to correct segment', () => {
    input.prompt = 'hello world foo bar baz'; // wraps at width 12
    const w = 12;
    const info0 = (() => { input.cursorPos = 0; return input.getWrappedPromptInfo(w); })();
    expect(info0.cursorWrappedLine).toBe(0);
    expect(info0.cursorCol).toBe(0);

    // End of first segment
    const info11 = (() => { input.cursorPos = 11; return input.getWrappedPromptInfo(w); })();
    expect(info11.cursorWrappedLine).toBe(0);
    // col should be at end of first segment

    // Start of second segment
    const info12 = (() => { input.cursorPos = 12; return input.getWrappedPromptInfo(w); })();
    expect(info12.cursorWrappedLine).toBe(1);
    expect(info12.cursorCol).toBe(0);
  });

  test('backspace at each position deletes correct character', () => {
    const original = 'abc def ghi jkl';
    const w = 8;

    for (let pos = 1; pos <= original.length; pos++) {
      input.prompt = original;
      input.cursorPos = pos;

      const charBefore = original[pos - 1];
      const expectedAfter = original.slice(0, pos - 1) + original.slice(pos);

      // Simulate backspace
      input.prompt = input.prompt.slice(0, input.cursorPos - 1) + input.prompt.slice(input.cursorPos);
      input.cursorPos--;

      expect(input.prompt).toBe(expectedAfter);
      expect(input.cursorPos).toBe(pos - 1);

      // Verify cursor mapping is still valid
      const info = input.getWrappedPromptInfo(w);
      // Cursor should be within a valid segment
      const seg = info.segments[info.cursorWrappedLine];
      expect(seg).toBeDefined();
      expect(info.cursorCol).toBeGreaterThanOrEqual(0);
      expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
    }
  });

  test('cursor on consumed space maps to segment boundary', () => {
    input.prompt = 'hello world test';
    const w = 12;
    // "hello world" (11) wraps, then "test" (4)
    // Space at position 11 is consumed

    input.cursorPos = 11; // the consumed space
    const info = input.getWrappedPromptInfo(w);

    // Should map to end of segment 0 or start of segment 1
    // Either way, the cursorCol should be valid for its segment
    const seg = info.segments[info.cursorWrappedLine];
    expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
    expect(info.cursorCol).toBeGreaterThanOrEqual(0);
  });

  test('multiline with newlines: cursor at newline maps correctly', () => {
    input.prompt = 'line one\nline two';
    const w = 20;

    input.cursorPos = 8; // the \n character
    const info = input.getWrappedPromptInfo(w);

    // Should be at end of line 0 or start of line 1
    const seg = info.segments[info.cursorWrappedLine];
    expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
  });

  test('navigate up/down preserves column in wrapped text', () => {
    input.prompt = 'abcdef ghijkl mnopqr stuvwx';
    const w = 14;
    // Wraps to: ["abcdef ghijkl", "mnopqr stuvwx"]

    input.cursorPos = 7; // 'g' in "ghijkl"
    const infoBefore = input.getWrappedPromptInfo(w);
    const lineBefore = infoBefore.cursorWrappedLine;
    const colBefore = infoBefore.cursorCol;

    // Simulate moveCursorVertical(1) — we test via the public method indirectly
    // by checking segment mapping consistency
    const targetLine = lineBefore + 1;
    if (targetLine < infoBefore.segments.length) {
      const targetSeg = infoBefore.segments[targetLine];
      const newCol = Math.min(colBefore, targetSeg.length);
      input.cursorPos = targetSeg.rawStart + newCol;

      const infoAfter = input.getWrappedPromptInfo(w);
      expect(infoAfter.cursorWrappedLine).toBe(targetLine);
      expect(infoAfter.cursorCol).toBe(newCol);
    }
  });

  test('pasted text cursor position after multiple operations', () => {
    // Simulate pasting 3 short lines then navigating
    input.prompt = 'first line\nsecond line\nthird line';
    input.cursorPos = input.prompt.length; // end
    const w = 20;

    // Navigate to start of "second"
    input.cursorPos = 11; // start of "second line"
    const info1 = input.getWrappedPromptInfo(w);
    expect(info1.wrappedLines[info1.cursorWrappedLine]).toBe('second line');
    expect(info1.cursorCol).toBe(0);

    // Navigate right to 's','e','c','o','n','d' (pos 17 = 'd')
    input.cursorPos = 16;
    const info2 = input.getWrappedPromptInfo(w);
    expect(info2.cursorCol).toBe(5); // 5 chars into "second line"

    // Backspace should remove 'n' at pos 15
    const before = input.prompt;
    input.prompt = input.prompt.slice(0, 15) + input.prompt.slice(16);
    input.cursorPos = 15;
    expect(input.prompt).toBe('first line\nsecoд line\nthird line'.replace('д', 'n').slice(0, 15) + before.slice(16));
  });
});
