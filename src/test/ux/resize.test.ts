/**
 * UX Anti-Regression: Terminal Resize Chain
 *
 * Pins the observable behavior of the resize event chain:
 *   stdout 'resize' → setContentWidth → compositor.resetDiff() → render()
 *
 * We test the two independently-testable links:
 *   1. compositor.resetDiff() causes the next composite() to emit more
 *      output than a no-op second frame would (i.e. full redraw).
 *   2. InputHandler.setContentWidth() updates the content width used for
 *      prompt wrapping calculations.
 *
 * Neither test asserts "exactly one render call" or timing — those would be
 * fragile if a debounce is added. Both assert observable state changes.
 *
 * Test #1 pins the delta contract precisely: the mock stream has no
 * getColorDepth(), so probeTermCaps() returns capability='none' and
 * syncedOutput=false. wrapSynced() therefore returns the empty string for
 * an all-identical diff, and compositor.composite() guards with `if (diff)`
 * before calling stdout.write(). An identical second frame produces exactly
 * 0 writes — not merely "fewer than the first paint".
 *
 * No real I/O, no real timers. All synchronous.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { Compositor } from '../../renderer/compositor.ts';
import type { CompositeRequest } from '../../renderer/compositor.ts';
import { createStyledCell } from '@pellux/goodvibes-sdk/platform/types';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream() {
  const writes: string[] = [];
  const stream = {
    write: (data: string) => { writes.push(data); return true; },
    writes,
  };
  return stream as unknown as NodeJS.WriteStream & { writes: string[] };
}

function makeCompositor(stream?: NodeJS.WriteStream & { writes: string[] }) {
  const s = stream ?? makeMockStream();
  const compositor = new Compositor(s as NodeJS.WriteStream);
  return { compositor, stream: s };
}

function makeLine(width: number, char = ' '): Line {
  return Array.from({ length: width }, () => createStyledCell(char));
}

function makeRequest(width: number, height: number): CompositeRequest {
  const headerRows = 2;
  const footerRows = 2;
  const viewportRows = Math.max(0, height - headerRows - footerRows);
  return {
    width,
    height,
    header: Array.from({ length: headerRows }, () => makeLine(width, 'H')),
    viewport: Array.from({ length: viewportRows }, () => makeLine(width, '.')),
    footer: Array.from({ length: footerRows }, () => makeLine(width, 'F')),
  };
}

function makeInputHandler(): InputHandler {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  return new InputHandler(
    () => {},
    sel,
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    createDefaultUiRuntimeServices(),
  );
}

// ---------------------------------------------------------------------------
// Tests: Compositor resize chain
// ---------------------------------------------------------------------------

describe('ux:resize — compositor.resetDiff causes full redraw on next composite', () => {
  test('second composite without resetDiff emits exactly 0 writes for an identical frame (strict delta contract)', () => {
    const { compositor, stream } = makeCompositor();
    // First composite: full initial render — writes entire screen
    compositor.composite(makeRequest(80, 24));
    const firstCount = stream.writes.length;
    expect(firstCount).toBeGreaterThan(0);

    // Second composite with identical content — the diff engine finds no dirty/changed
    // cells, produces an empty diff string, and wrapSynced() returns it unchanged
    // (syncedOutput=false on the mock stream). The `if (diff)` guard in composite()
    // suppresses the write entirely, so exactly 0 writes are emitted.
    const beforeSecond = stream.writes.length;
    compositor.composite(makeRequest(80, 24));
    const secondCount = stream.writes.length - beforeSecond;

    // Strict delta contract: an identical frame must produce 0 writes.
    // toBeLessThan(firstCount) would pass even on full-redraw regression;
    // toBe(0) catches any delta-engine bypass.
    expect(secondCount).toBe(0);
  });

  test('resetDiff followed by composite emits more writes than a delta-only frame', () => {
    const { compositor, stream } = makeCompositor();
    compositor.composite(makeRequest(80, 24));

    // Settle: do a second no-op frame to consume the delta baseline.
    compositor.composite(makeRequest(80, 24));
    const baselineCount = stream.writes.length;

    // Now do a clean resetDiff (as the resize handler does) then composite.
    compositor.resetDiff();
    compositor.composite(makeRequest(80, 24));
    const afterResetCount = stream.writes.length - baselineCount;

    // A post-reset composite must write more than a delta-only no-op frame
    // because resetDiff nulls both buffers, forcing a full repaint.
    expect(afterResetCount).toBeGreaterThan(0);
  });

  test('resetDiff with new dimensions produces buffer matching new width', () => {
    const { compositor } = makeCompositor();
    compositor.composite(makeRequest(80, 24));
    expect(compositor.lastBufferForTest?.width).toBe(80);

    // Simulate resize: new dimensions
    compositor.resetDiff();
    compositor.composite(makeRequest(120, 30));
    expect(compositor.lastBufferForTest?.width).toBe(120);
  });

  test('resetDiff with smaller dimensions produces buffer matching smaller width', () => {
    const { compositor } = makeCompositor();
    compositor.composite(makeRequest(80, 24));
    compositor.resetDiff();
    compositor.composite(makeRequest(40, 12));
    expect(compositor.lastBufferForTest?.width).toBe(40);
  });

  test('multiple resize cycles (resetDiff + composite) do not throw', () => {
    const { compositor } = makeCompositor();
    const dims = [
      { width: 80, height: 24 },
      { width: 40, height: 12 },
      { width: 160, height: 50 },
      { width: 80, height: 24 },
    ];
    expect(() => {
      for (const { width, height } of dims) {
        compositor.resetDiff();
        compositor.composite(makeRequest(width, height));
      }
    }).not.toThrow();
    // Final state reflects last dimensions
    expect(compositor.lastBufferForTest?.width).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Tests: InputHandler.setContentWidth (prompt reflow on resize)
// ---------------------------------------------------------------------------

describe('ux:resize — setContentWidth updates prompt wrapping width', () => {
  let input: InputHandler;

  beforeEach(() => {
    input = makeInputHandler();
    input.setContentWidth(80);
  });

  test('setContentWidth accepts a new width without throwing', () => {
    expect(() => input.setContentWidth(40)).not.toThrow();
    expect(() => input.setContentWidth(120)).not.toThrow();
    expect(() => input.setContentWidth(1)).not.toThrow();
  });

  test('getVisiblePromptLineCount reflects new width after setContentWidth', () => {
    // A 40-char prompt at width 80 fits in 1 line; at width 10 it wraps.
    const longPrompt = 'a'.repeat(40);
    input.prompt = longPrompt;

    input.setContentWidth(80);
    const lineCountWide = input.getVisiblePromptLineCount(80);

    input.setContentWidth(10);
    const lineCountNarrow = input.getVisiblePromptLineCount(10);

    // Narrower width must require at least as many lines as wider width.
    expect(lineCountNarrow).toBeGreaterThanOrEqual(lineCountWide);
    // At width 10, a 40-char prompt definitely wraps to more than 1 line.
    expect(lineCountNarrow).toBeGreaterThan(1);
  });

  test('setContentWidth to very small value does not throw', () => {
    input.prompt = 'hello world';
    expect(() => input.setContentWidth(1)).not.toThrow();
  });

  test('setContentWidth to same value is idempotent', () => {
    input.setContentWidth(80);
    const before = input.getVisiblePromptLineCount(80);
    input.setContentWidth(80);
    const after = input.getVisiblePromptLineCount(80);
    expect(after).toBe(before);
  });
});
