// ---------------------------------------------------------------------------
// conversation-rendering.test.ts
//
// Covers two rendering-honesty guarantees:
//   - thinking blocks: collapsed by default to one line, and the registered
//     collapse key actually toggles them.
//   - bead blocks: a bead's block counts exactly the rows it draws (its row,
//     plus its body when open), and an opened result never shows raw JSON.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

function textOf(cm: ConversationManager): string {
  return cm.history.getAllLines().map((line) => line.map((c) => c.char).join('')).join('\n');
}

describe('thinking block collapse', () => {
  function buildWithThinking(): ConversationManager {
    const cm = new ConversationManager(() => 80);
    // showThinking defaults to false unless configManager says otherwise,
    // wire a stub that turns display.showThinking on, same as main.ts does
    // via setConfigManager() after construction.
    cm.setConfigManager({
      get: (key: string) => (key === 'display.showThinking' ? true : undefined),
    } as unknown as Parameters<typeof cm.setConfigManager>[0]);
    cm.addAssistantMessage('Here is my answer.', { reasoningContent: 'step one\nstep two\nstep three' });
    cm.getDisplayBlocks();
    return cm;
  }

  test('renders collapsed by default as one honest summary line, not the full reasoning text', () => {
    const cm = buildWithThinking();
    const text = textOf(cm);
    // One row: the label and the ▸ size badge, the same collapse affordance
    // every other folded block carries. No preview, reasoning text stays
    // behind the toggle.
    expect(text).toContain('thinking  ▸ 3 lines');
    expect(text).not.toContain('step one');
  });

  test('the registered thinking collapseKey actually controls expansion (the toggle used to do nothing)', () => {
    const cm = buildWithThinking();
    const thinkingBlock = cm.getBlockRegistry().find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(cm.isCollapsed(thinkingBlock!.blockIndex)).toBe(true);

    cm.setCollapsed(thinkingBlock!.collapseKey, false);
    cm.getDisplayBlocks();

    const text = textOf(cm);
    expect(text).toContain('step one');
    expect(text).toContain('step two');
    expect(text).toContain('step three');
    expect(text).not.toContain('thinking  ▸ 3 lines');
  });
});

describe('bead blocks count the rows they draw', () => {
  test('a closed bead is one row; opened, its block spans the row and its whole body, never raw JSON', () => {
    const cm = new ConversationManager(() => 80);
    const padding: Record<string, number> = {};
    for (let i = 0; i < 20; i++) padding[`field_${i}`] = i;
    const jsonContent = JSON.stringify({ files_written: 1, bytes_written: 42, ...padding });
    cm.addUserMessage('go');
    cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'custom_tool', arguments: {} }] });
    cm.addToolResults([{ callId: 'c1', success: true, output: jsonContent }]);
    cm.getDisplayBlocks();

    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    expect(block).toBeDefined();
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);
    expect(block!.lineCount).toBe(1);

    cm.setCollapsed(block!.collapseKey, false);
    const lines = cm.getDisplayBlocks();
    const opened = cm.getBlockRegistry().find((b) => b.collapseKey === block!.collapseKey)!;
    const textOfBlock = (from: typeof lines, b: typeof opened): string => from.slice(b.startLine, b.startLine + b.lineCount).map((l) => l.map((c) => c.char).join('')).join('\n');
    // 22 fields: the first 12 rows show, then "… 10 more lines", inside padding rows.
    expect(opened.lineCount).toBe(1 + 1 + 12 + 1 + 1);
    expect(textOfBlock(lines, opened)).toContain('files_written  1');
    expect(textOfBlock(lines, opened)).toContain('… 10 more lines');
    expect(textOfBlock(lines, opened)).not.toContain('{');

    // → on an open, capped body shows the rest.
    cm.setCollapsed(opened.workTree!.moreKey!, true);
    const all = cm.getDisplayBlocks();
    const expanded = cm.getBlockRegistry().find((b) => b.collapseKey === block!.collapseKey)!;
    expect(expanded.lineCount).toBe(1 + 1 + 22 + 1);
    expect(textOfBlock(all, expanded)).toContain('field_19  19');
    // The line after the block is the next thing, not more of this body.
    expect(all[expanded.startLine + expanded.lineCount]!.every((c) => c.bg === '')).toBe(true);
  });

  test('the turn header block reveals each result through its own bead key', () => {
    const cm = new ConversationManager(() => 80);
    cm.addUserMessage('go');
    cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'read', arguments: {} }, { id: 'c2', name: 'read', arguments: {} }] });
    cm.addToolResults([{ callId: 'c1', success: true, output: 'first' }, { callId: 'c2', success: true, output: 'second' }]);
    cm.getDisplayBlocks();
    const turn = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn')!;
    expect(turn.groupMemberIndexes).toEqual([2, 3]);
    expect(turn.groupMemberKeys).toEqual(['bead_c:1:0', 'bead_c:1:1']);
  });
});
