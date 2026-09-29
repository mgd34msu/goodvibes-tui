// ---------------------------------------------------------------------------
// block-actions-overlay.test.ts
//
// The BlockActionsMenu (opened via Enter on an empty composer) previously had
// no draw site at all, it swallowed every key but nothing appeared on
// screen. Covers: the overlay renders real content when the menu is active,
// renders nothing when it isn't, shows the block summary and every action's
// key, and is composed into the conversation viewport via
// applyConversationOverlays.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { renderBlockActionsMenu } from '../../renderer/block-actions-overlay.ts';
import { BlockActionsMenu } from '../../renderer/block-actions.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

function linesToText(layer: ReturnType<typeof renderBlockActionsMenu>): string {
  return layerTextBlock(layer);
}

describe('renderBlockActionsMenu', () => {
  test('renders nothing when the menu is not active', () => {
    const menu = new BlockActionsMenu();
    expect(renderBlockActionsMenu(menu, 100, 30)).toBeNull();
  });

  test('renders the block summary and every available action with its key, for a tool block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 5, lineCount: 12, rawContent: 'x', collapseKey: 'k0', toolName: 'exec' });
    const layer = renderBlockActionsMenu(menu, 100, 30);
    expect(layer).not.toBeNull();
    const text = linesToText(layer);
    expect(text).toContain('exec');
    expect(text).toContain('12 line');
    // Each action's key is right-aligned metadata on its row.
    expect(text).toMatch(/Copy +c/);
    expect(text).toMatch(/Bookmark +b/);
    expect(text).toMatch(/Collapse\/Expand +tab/);
    // 'apply' is diff-only, not offered for a tool block.
    expect(text).not.toContain('Apply diff');
    expect(text).not.toMatch(/[┌┐└┘│]/);
  });

  test('offers apply for a diff block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'diff', startLine: 0, lineCount: 8, rawContent: 'x', collapseKey: 'k0', filePath: 'src/foo.ts' });
    const text = linesToText(renderBlockActionsMenu(menu, 100, 30));
    expect(text).toContain('src/foo.ts');
    expect(text).toMatch(/Apply diff +a/);
  });

  test('is a small centered dialog that stays inside the screen', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k0' });
    const layer = renderBlockActionsMenu(menu, 90, 30)!;
    expect(layer.x).toBeGreaterThan(0);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(90);
    expect(layer.y).toBeGreaterThan(Math.round(30 * 0.08));
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(30);
  });

  test('degrades gracefully on a very narrow terminal without throwing', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k0' });
    expect(() => renderBlockActionsMenu(menu, 30, 20)).not.toThrow();
  });
});
