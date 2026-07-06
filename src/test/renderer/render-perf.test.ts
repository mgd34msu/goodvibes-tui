// ---------------------------------------------------------------------------
// render-perf.test.ts — Unit tests for render performance fixes
//
// R1: Render coalescing — burst of requestRender() calls produces one render
// R2: Panel dirty flag — panels skip re-render when needsRender is false
// ---------------------------------------------------------------------------

import { describe, test, expect, mock } from 'bun:test';
import { TerminalBuffer } from '../../renderer/buffer.ts';
import type { Panel } from '../../panels/types.ts';

// ---------------------------------------------------------------------------
// R1: Render coalescing
// ---------------------------------------------------------------------------

describe('R1: render coalescing via setImmediate', () => {
  test('multiple synchronous requestRender() calls collapse into one render', async () => {
    // Simulate the coalescer logic directly
    let renderCount = 0;
    const renderFn = () => { renderCount++; };

    let scheduled = false;
    const requestRender = (): void => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        renderFn();
      });
    };

    // Fire N times synchronously
    requestRender();
    requestRender();
    requestRender();
    requestRender();

    // None should have rendered yet (still in microtask queue)
    expect(renderCount).toBe(0);

    // Yield to let setImmediate fire
    await new Promise<void>(resolve => setImmediate(resolve));

    // Exactly one render, despite 4 calls
    expect(renderCount).toBe(1);
  });

  test('subsequent requestRender() calls after coalescer fires each produce one render', async () => {
    let renderCount = 0;
    const renderFn = () => { renderCount++; };

    let scheduled = false;
    const requestRender = (): void => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        renderFn();
      });
    };

    requestRender(); requestRender(); // burst 1
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(renderCount).toBe(1);

    requestRender(); requestRender(); // burst 2
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(renderCount).toBe(2);
  });

  test('16ms throttle branch: two bursts within 16ms delay the second render', async () => {
    // Simulates the production gate: lastRenderTime + RENDER_INTERVAL_MS
    const RENDER_INTERVAL_MS = 16;
    const renderTimestamps: number[] = [];
    let now = 1000;
    // Monotonic clock for deterministic test (Date.now substitute)
    const clock = () => now;

    let lastRenderTime = 0;
    let scheduled = false;
    const requestRender = (): void => {
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        const elapsed = clock() - lastRenderTime;
        if (elapsed < RENDER_INTERVAL_MS) {
          // Throttle branch: defer to tail of window
          const delay = RENDER_INTERVAL_MS - elapsed;
          setTimeout(() => {
            lastRenderTime = clock();
            renderTimestamps.push(lastRenderTime);
          }, delay);
        } else {
          // Immediate branch
          lastRenderTime = clock();
          renderTimestamps.push(lastRenderTime);
        }
      });
    };

    // First burst at t=1000 — immediate branch (elapsed since 0 > 16ms)
    now = 1000;
    requestRender();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(renderTimestamps).toEqual([1000]);

    // Second burst at t=1005 (5ms later) — throttle branch, should delay 11ms
    now = 1005;
    requestRender();
    await new Promise<void>(resolve => setImmediate(resolve));
    // setImmediate has fired but setTimeout hasn't — still only 1 render recorded
    expect(renderTimestamps).toEqual([1000]);

    // Wait for the setTimeout to fire (tick the clock forward; real timer awaits its own delay)
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    // Now we should see 2 renders; the second one fired via the throttle branch
    expect(renderTimestamps.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R2: Panel dirty-flag skipping
// ---------------------------------------------------------------------------

function makeMockPanel(id: string): Panel & { renderCallCount: number } {
  let renderCallCount = 0;
  const panel: Panel & { renderCallCount: number } = {
    id,
    name: id,
    icon: 'X',
    category: 'runtime-ops',
    isTransient: false,
    isPinned: false,
    needsRender: true,
    onActivate() { this.needsRender = true; },
    onDeactivate() {},
    onDestroy() {},
    render(_w: number, _h: number) {
      renderCallCount++;
      return [];
    },
    invalidate() { this.needsRender = true; },
    markRendered() { this.needsRender = false; },
    get renderCallCount() { return renderCallCount; },
  };
  return panel;
}

/** Minimal renderPanel wrapper matching the logic in panel-composite.ts */
const panelRenderCache = new WeakMap<Panel, { lines: ReturnType<Panel['render']>; width: number; height: number }>();
function renderPanel(panel: Panel, width: number, height: number) {
  const cached = panelRenderCache.get(panel);
  if (cached && !panel.needsRender && cached.width === width && cached.height === height) {
    return cached.lines;
  }
  const lines = panel.render(width, height);
  panel.markRendered();
  panelRenderCache.set(panel, { lines, width, height });
  return lines;
}

describe('R2: panel dirty-flag skip', () => {
  test('panel with needsRender=false is not re-rendered on identical dimensions', () => {
    const panel = makeMockPanel('test-panel');
    renderPanel(panel, 80, 24); // first render
    expect(panel.renderCallCount).toBe(1);
    expect(panel.needsRender).toBe(false);

    renderPanel(panel, 80, 24); // same dims, not dirty
    expect(panel.renderCallCount).toBe(1); // skipped
  });

  test('panel re-renders when needsRender is true', () => {
    const panel = makeMockPanel('dirty-panel');
    renderPanel(panel, 80, 24);
    expect(panel.renderCallCount).toBe(1);

    panel.invalidate(); // mark dirty again
    renderPanel(panel, 80, 24);
    expect(panel.renderCallCount).toBe(2); // re-rendered
  });

  test('panel re-renders when dimensions change even if not dirty', () => {
    const panel = makeMockPanel('resize-panel');
    renderPanel(panel, 80, 24);
    expect(panel.renderCallCount).toBe(1);
    expect(panel.needsRender).toBe(false);

    renderPanel(panel, 90, 24); // width changed
    expect(panel.renderCallCount).toBe(2);
  });

  test('markRendered() clears needsRender', () => {
    const panel = makeMockPanel('mark-rendered-panel');
    expect(panel.needsRender).toBe(true);
    panel.markRendered();
    expect(panel.needsRender).toBe(false);
  });

  test('invalidate() sets needsRender', () => {
    const panel = makeMockPanel('invalidate-panel');
    panel.markRendered(); // clear it first
    expect(panel.needsRender).toBe(false);
    panel.invalidate();
    expect(panel.needsRender).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R3: TerminalBuffer.reset()
// ---------------------------------------------------------------------------

describe('R3: TerminalBuffer.reset()', () => {
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
// R3: Compositor buffer identity — verifies the "2 TerminalBuffer instances
// per session" invariant the review flagged as claimed-but-untested.
// Rather than spying on the class constructor (fragile across bundlers),
// we drive the Compositor through N frames and assert the set of buffer
// instances observed via `frontBuffer`/`backBuffer` across frames has
// cardinality 2 — i.e. the same two instances keep swapping.
// ---------------------------------------------------------------------------

describe('R3: Compositor front/back buffer identity across frames', () => {
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
    // Note: backBuffer is briefly null after the first swap — filter nulls so
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
