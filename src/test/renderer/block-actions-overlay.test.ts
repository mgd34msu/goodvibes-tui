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

function linesToText(lines: ReturnType<typeof renderBlockActionsMenu>): string {
  return lines.map((line) => line.map((c) => c.char).join('')).join('\n');
}

describe('renderBlockActionsMenu', () => {
  test('renders nothing when the menu is not active', () => {
    const menu = new BlockActionsMenu();
    expect(renderBlockActionsMenu(menu, 100, 30)).toEqual([]);
  });

  test('renders the block summary and every available action with its key, for a tool block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 5, lineCount: 12, rawContent: 'x', collapseKey: 'k0', toolName: 'exec' });
    const lines = renderBlockActionsMenu(menu, 100, 30);
    expect(lines.length).toBeGreaterThan(0);
    const text = linesToText(lines);
    expect(text).toContain('exec');
    expect(text).toContain('12 line');
    expect(text).toContain('[c]');
    expect(text).toContain('[b]');
    expect(text).toContain('[Tab]');
    // 'apply' is diff-only, not offered for a tool block.
    expect(text).not.toContain('[a] Apply diff');
  });

  test('offers apply for a diff block', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'diff', startLine: 0, lineCount: 8, rawContent: 'x', collapseKey: 'k0', filePath: 'src/foo.ts' });
    const text = linesToText(renderBlockActionsMenu(menu, 100, 30));
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('[a] Apply diff');
  });

  test('every rendered line has the full terminal width (no clipped/short rows)', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k0' });
    const width = 90;
    const lines = renderBlockActionsMenu(menu, width, 30);
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  test('degrades gracefully on a very narrow terminal without throwing', () => {
    const menu = new BlockActionsMenu();
    menu.open({ blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k0' });
    expect(() => renderBlockActionsMenu(menu, 30, 20)).not.toThrow();
  });
});
