import { describe, expect, test } from 'bun:test';
import type { Panel } from '../../panels/types.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { renderPanel } from '../../renderer/panel-composite.ts';

/**
 * Minimal Panel implementation for render cache / race-guard tests.
 *
 * Each test creates fresh instances so module-level WeakMap state from a prior
 * test never leaks, WeakMap entries are keyed by object identity and are
 * unreachable once the panel variable goes out of scope.
 */
function makeMockPanel(
  id: string,
  renderHook?: () => void,
): Panel {
  let _needsRender = true;
  return {
    id,
    name: id,
    icon: id[0]?.toUpperCase() ?? 'P',
    category: 'runtime-ops',
    isTransient: false,
    isPinned: false,
    get needsRender() { return _needsRender; },
    set needsRender(v: boolean) { _needsRender = v; },
    onActivate() {},
    onDeactivate() {},
    onDestroy() {},
    render(_width: number, _height: number): Line[] {
      if (renderHook) renderHook();
      return [];
    },
    invalidate() { _needsRender = true; },
    markRendered() { _needsRender = false; },
  };
}

describe('panel-composite render cache race guard (Fix 3)', () => {
  test('normal render: markRendered is called, needsRender becomes false', () => {
    const panel = makeMockPanel('normal');
    panel.needsRender = true;

    renderPanel(panel, 80, 24);

    expect(panel.needsRender).toBe(false);
  });

  test('mid-render invalidation: needsRender stays true after render', () => {
    // Simulate: an event listener calls panel.invalidate() during render().
    // The generation counter bumps during render. The guard detects this and
    // does NOT call markRendered(), so needsRender remains true.
    let renderFired = false;
    const panel = makeMockPanel('mid-render-race');
    // Prime the generation wrapper by rendering once without a hook.
    renderPanel(panel, 80, 24); // first render, marks rendered
    expect(panel.needsRender).toBe(false);

    // Now set up the invalidation hook and trigger a new dirty render.
    panel.invalidate(); // makes needsRender=true again
    const origRender = panel.render.bind(panel);
    panel.render = (w, h) => {
      renderFired = true;
      // Mid-render: invalidate fires, bumping the generation counter
      panel.invalidate();
      return origRender(w, h);
    };

    renderPanel(panel, 80, 24);

    expect(renderFired).toBe(true);
    // Generation changed during render, markRendered was skipped.
    expect(panel.needsRender).toBe(true);
  });

  test('second render after mid-render invalidation succeeds and clears dirty', () => {
    // After the race, the panel is still dirty. The next render should succeed.
    let callCount = 0;
    const panel = makeMockPanel('two-pass');

    // Prime wrapper
    renderPanel(panel, 80, 24);
    panel.invalidate();

    // Hook: first render triggers invalidation, second doesn't
    const origRender = panel.render.bind(panel);
    panel.render = (w, h) => {
      callCount++;
      if (callCount === 1) panel.invalidate();
      return origRender(w, h);
    };

    // First render: race fires, stays dirty
    renderPanel(panel, 80, 24);
    expect(panel.needsRender).toBe(true);

    // Second render: no race, marks rendered
    renderPanel(panel, 80, 24);
    expect(panel.needsRender).toBe(false);
    expect(callCount).toBe(2);
  });

  test('cache hit path: render() is NOT called when panel is clean and dims unchanged', () => {
    let renderCallCount = 0;
    const panel = makeMockPanel('cache-hit');
    panel.render = () => { renderCallCount++; return []; };

    // First render, cold cache
    renderPanel(panel, 80, 24);
    expect(renderCallCount).toBe(1);
    expect(panel.needsRender).toBe(false);

    // Second call with same dims and panel still clean, should be a cache hit
    renderPanel(panel, 80, 24);
    expect(renderCallCount).toBe(1); // render() NOT called again
  });
});
