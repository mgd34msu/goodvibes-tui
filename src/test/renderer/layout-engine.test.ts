import { describe, expect, test } from 'bun:test';
import { createShellLayout } from '../../renderer/layout-engine.ts';

describe('layout engine', () => {
  test('the conversation takes the full width of the body (there are no side areas)', () => {
    const layout = createShellLayout({ width: 120, height: 40, headerHeight: 2, footerHeight: 10 });
    expect(layout.body.height).toBe(28);
    expect(layout.conversation.width).toBe(120);
    expect(layout.conversation.y).toBe(2);
    expect(layout.footer.y).toBe(30);
  });

  test('clamps header and footer to the screen', () => {
    const layout = createShellLayout({ width: 10, height: 5, headerHeight: 4, footerHeight: 4 });
    expect(layout.header.height).toBe(4);
    expect(layout.footer.height).toBe(1);
    expect(layout.body.height).toBe(0);
  });
});
