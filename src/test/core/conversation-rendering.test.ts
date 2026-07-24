// ---------------------------------------------------------------------------
// conversation-rendering.test.ts
//
// Covers two rendering-honesty fixes:
//   - thinking blocks: registered a collapse key that Tab never actually
//     consulted (always rendered in full regardless of collapse state).
//     Now collapsed by default to one line, and the toggle actually toggles.
//   - "N lines" badges: computed from raw message content, not what
//     expansion actually renders — a JSON blob that pretty-prints to many
//     lines used to show "1 line" while collapsed. Now the badge always
//     names the post-expansion line count, for both single tool results and
//     folded tool-result groups.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { renderExpandedToolResultLines } from '../../renderer/tool-result-expanded-lines.ts';

function textOf(cm: ConversationManager): string {
  return cm.history.getAllLines().map((line) => line.map((c) => c.char).join('')).join('\n');
}

describe('thinking block collapse', () => {
  function buildWithThinking(): ConversationManager {
    const cm = new ConversationManager(() => 80);
    // showThinking defaults to false unless configManager says otherwise —
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
    expect(text).toContain('thinking · 3 lines');
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
    expect(text).not.toContain('thinking · 3 lines');
  });
});

describe('tool-result "N lines" badge honesty', () => {
  test('the badge counts the EXPANDED (pretty-printed JSON) line count, not the raw one-line content', () => {
    const cm = new ConversationManager(() => 80);
    // Deliberately long (>200 chars) and an unrecognized tool family, so
    // summarizeToolResult returns null and the block collapses by default —
    // exercising the "still says the true expanded count while collapsed"
    // path rather than the isShort-always-expanded path.
    const padding: Record<string, number> = {};
    for (let i = 0; i < 20; i++) padding[`field_${i}`] = i;
    const jsonContent = JSON.stringify({ files_written: 1, bytes_written: 42, ...padding });
    expect(jsonContent.length).toBeGreaterThan(200);
    cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'custom_tool', arguments: {} }] });
    cm.addToolResults([{ callId: 'c1', success: true, output: jsonContent }]);
    cm.getDisplayBlocks();

    const block = cm.getBlockRegistry().find((b) => b.type === 'tool');
    expect(block).toBeDefined();
    // Collapsed by default (long/unsummarizable JSON) — the header badge
    // must still name what Tab would reveal, not "1 line" (raw JSON has no
    // newlines).
    expect(cm.isCollapsed(block!.blockIndex)).toBe(true);

    const collapsedHeaderText = textOf(cm);
    const collapsedMatch = /(\d+) lines?/.exec(collapsedHeaderText);
    expect(collapsedMatch).not.toBeNull();
    const claimedLines = Number(collapsedMatch![1]);
    expect(claimedLines).toBeGreaterThan(1); // NOT the raw "1 line" lie

    // The claimed count must match what expansion ACTUALLY renders — the
    // same invariant tool-result-expanded-lines.ts is the shared source of
    // truth for (both the badge and conversation-tool-groups.ts's group
    // totals compute from it).
    expect(claimedLines).toBe(renderExpandedToolResultLines(jsonContent, 80).length);

    cm.setCollapsed(block!.collapseKey, false);
    cm.getDisplayBlocks();
    const expandedText = textOf(cm);
    expect(expandedText).toContain('files_written');
  });

  test('a folded tool-result group total matches the sum of each member\'s expanded line count', () => {
    const cm = new ConversationManager(() => 80);
    const jsonA = JSON.stringify({ a: 1, b: 2, c: 3, d: 4 });
    cm.addAssistantMessage('', {
      toolCalls: [
        { id: 'c1', name: 'read', arguments: {} },
        { id: 'c2', name: 'read', arguments: {} },
      ],
    });
    cm.addToolResults([
      { callId: 'c1', success: true, output: jsonA },
      { callId: 'c2', success: true, output: 'plain short result' },
    ]);
    cm.getDisplayBlocks();

    const groupBlock = cm.getBlockRegistry().find((b) => b.type === 'tool_group');
    expect(groupBlock).toBeDefined();
    const headerText = textOf(cm);
    expect(headerText).toContain('read×2');
    const match = /(\d+) lines? total|(\d+) lines?(?!\stotal)/.exec(headerText);
    expect(match).not.toBeNull();
  });
});
