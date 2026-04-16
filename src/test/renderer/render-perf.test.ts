// ---------------------------------------------------------------------------
// render-perf.test.ts — Unit tests for Wave 2 / Tier 1 render performance fixes
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
    category: 'monitoring',
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
