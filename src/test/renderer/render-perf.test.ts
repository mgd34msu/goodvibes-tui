// ---------------------------------------------------------------------------
// render-perf.test.ts, buffer reuse in the renderer (no per-frame allocation)
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { TerminalBuffer } from '../../renderer/buffer.ts';

// ---------------------------------------------------------------------------
// TerminalBuffer.reset()
// ---------------------------------------------------------------------------

describe('TerminalBuffer.reset()', () => {
  test('reset() clears cells in-place without reallocation for same dimensions', () => {
    const buf = new TerminalBuffer(10, 5);
    // Set a recognizable char
    buf.setCell(3, 2, { char: 'Z' });
    expect(buf.getCell(3, 2)?.char).toBe('Z');

    buf.reset(10, 5);
    // After reset, cell should be cleared to empty (space)
    expect(buf.getCell(3, 2)?.char).toBe(' ');
    // Width/height unchanged
    expect(buf.width).toBe(10);
    expect(buf.height).toBe(5);
  });

  test('reset() with new dimensions reallocates cells', () => {
    const buf = new TerminalBuffer(10, 5);
    buf.reset(20, 8);
    expect(buf.width).toBe(20);
    expect(buf.height).toBe(8);
    expect(buf.cells.length).toBe(8);
    expect(buf.cells[0]!.length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Compositor buffer identity, verifies the "2 TerminalBuffer instances
// per session" invariant the review flagged as claimed-but-untested.
// Rather than spying on the class constructor (fragile across bundlers),
// we drive the Compositor through N frames and assert the set of buffer
// instances observed via `frontBuffer`/`backBuffer` across frames has
// cardinality 2, i.e. the same two instances keep swapping.
// ---------------------------------------------------------------------------

describe('Compositor front/back buffer identity across frames', () => {
  test('front and back buffer instances are stable across many composite() calls', async () => {
    const { Compositor } = await import('../../renderer/compositor.ts');
    // Stub stdout so composite() does not emit escape codes to the test runner
    const stubStdout = {
      write: () => true,
      columns: 20,
      rows: 5,
    } as unknown as NodeJS.WriteStream;

    const compositor = new Compositor(stubStdout);
    const observedBuffers = new Set<unknown>();

    const req = {
      width: 20,
      height: 5,
      header: [],
      viewport: [],
      footer: [],
    } as Parameters<typeof compositor.composite>[0];

    // Drive 10 frames. After the first 2 frames, both slots are populated and
    // the compositor swaps between exactly 2 TerminalBuffer instances.
    // Note: backBuffer is briefly null after the first swap, filter nulls so
    // we count only real TerminalBuffer identities.
    for (let i = 0; i < 10; i++) {
      compositor.composite(req);
      const front = (compositor as unknown as { frontBuffer: unknown }).frontBuffer;
      const back = (compositor as unknown as { backBuffer: unknown }).backBuffer;
      if (front !== null) observedBuffers.add(front);
      if (back !== null) observedBuffers.add(back);
    }

    // Strict invariant: exactly 2 distinct buffer instances across 10 frames.
    // If the compositor were allocating per frame, this would be 20.
    expect(observedBuffers.size).toBe(2);
  });
});
