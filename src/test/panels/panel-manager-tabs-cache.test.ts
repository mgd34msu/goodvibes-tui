// ---------------------------------------------------------------------------
// panel-manager-tabs-cache.test.ts
// β1: PanelManager.getWorkspaceTabs() cache — same reference on repeated calls,
// broken on lifecycle mutations.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { PanelManager } from '../../panels/panel-manager.ts';
import type { Panel } from '../../panels/types.ts';
import type { PanelRegistration } from '../../panels/types.ts';

function makePanel(id: string): Panel {
  return {
    id,
    name: id,
    icon: id[0]!,
    category: 'monitoring',
    needsRender: false,
    isTransient: false,
    isPinned: false,
    markRendered() {},
    invalidate() { this.needsRender = true; },
    onActivate() {},
    onDeactivate() {},
    onDestroy() {},
    render(_w: number, _h: number) { return []; },
  };
}

function makeReg(id: string): PanelRegistration {
  return {
    id,
    name: id,
    icon: id[0]!,
    description: id,
    category: 'monitoring',
    factory: () => makePanel(id),
  };
}

describe('PanelManager.getWorkspaceTabs() cache (β1)', () => {
  let pm: PanelManager;

  beforeEach(() => {
    pm = new PanelManager();
    pm.registerType(makeReg('alpha'));
    pm.registerType(makeReg('beta'));
    pm.registerType(makeReg('gamma'));
  });

  test('returns same array reference on repeated calls with no state change', () => {
    pm.open('alpha');
    const first = pm.getWorkspaceTabs();
    const second = pm.getWorkspaceTabs();
    expect(first).toBe(second);
  });

  test('cache is invalidated after open()', () => {
    pm.open('alpha');
    const before = pm.getWorkspaceTabs();
    pm.open('beta');
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
    expect(after.length).toBe(2);
  });

  test('cache is invalidated after close()', () => {
    pm.open('alpha');
    pm.open('beta');
    const before = pm.getWorkspaceTabs();
    pm.close('beta');
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
    expect(after.length).toBe(1);
  });

  test('cache is invalidated after nextPanel()', () => {
    pm.open('alpha');
    pm.open('beta');
    const before = pm.getWorkspaceTabs();
    pm.nextPanel();
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
  });

  test('cache is invalidated after activateByIndex()', () => {
    pm.open('alpha');
    pm.open('beta');
    const before = pm.getWorkspaceTabs();
    pm.activateByIndex(0);
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
  });

  test('cache is invalidated after focusPane()', () => {
    pm.open('alpha');
    pm.open('beta', 'bottom');
    const before = pm.getWorkspaceTabs();
    pm.focusPane('bottom');
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
  });

  test('cache is invalidated after toggleBottomPane()', () => {
    pm.open('alpha');
    pm.open('beta');
    const before = pm.getWorkspaceTabs();
    pm.toggleBottomPane();
    const after = pm.getWorkspaceTabs();
    expect(before).not.toBe(after);
  });

  test('repeated calls after lifecycle event return same new reference', () => {
    pm.open('alpha');
    pm.open('beta');
    const first = pm.getWorkspaceTabs();
    const second = pm.getWorkspaceTabs();
    // Stable between calls
    expect(first).toBe(second);
  });
});
