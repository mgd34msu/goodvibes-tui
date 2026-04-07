import { describe, expect, test } from 'bun:test';
import { createShellLayout, createSplitPaneLayout } from '../../renderer/layout-engine.ts';

describe('layout engine', () => {
  test('creates a shell layout with stable conversation and panel regions', () => {
    const layout = createShellLayout({
      width: 120,
      height: 40,
      headerHeight: 2,
      footerHeight: 10,
      panelWidth: 32,
    });

    expect(layout.body.height).toBe(28);
    expect(layout.conversation.width).toBe(87);
    expect(layout.panel?.width).toBe(32);
    expect(layout.separatorX).toBe(87);
  });

  test('creates a split-pane layout with tab and separator chrome reserved', () => {
    const split = createSplitPaneLayout(24, 0.6);
    expect(split.topContentRows).toBeGreaterThan(0);
    expect(split.bottomContentRows).toBeGreaterThan(0);
    expect(split.topContentRows + split.bottomContentRows + split.topTabRows + split.bottomTabRows + split.separatorRows).toBe(24);
  });
});
