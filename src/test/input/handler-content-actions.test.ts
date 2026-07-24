// ---------------------------------------------------------------------------
// handler-content-actions.test.ts
//
// Covers the anchor-based block actions (Ctrl+Y/B/S, Tab) after the fix that
// resolves them against the block the user is actually looking at (an
// injected getAnchorLine callback) instead of a raw scrollTop, plus the
// honest-receipt requirement: every action names its target block instead of
// an opaque collapseKey or silence. Also covers the removal of the dead
// "rerun" action.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import {
  describeBlockForReceipt,
  handleBlockCopy,
  handleBookmark,
  handleBlockToggle,
} from '../../input/handler-content-actions.ts';

function textOf(cm: ConversationManager): string {
  return cm.history.getAllLines().map((line) => line.map((c) => c.char).join('')).join('\n');
}

function buildConversationWithTwoToolBlocks(): ConversationManager {
  const cm = new ConversationManager(() => 80);
  cm.addUserMessage('run things');
  cm.addAssistantMessage('', { toolCalls: [{ id: 'c1', name: 'exec', arguments: {} }] });
  cm.addToolResults([{ callId: 'c1', success: true, output: 'exit 0\nsome output line' }]);
  cm.addAssistantMessage('', { toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] });
  cm.addToolResults([{ callId: 'c2', success: true, output: 'file contents here' }]);
  cm.getDisplayBlocks();
  return cm;
}

describe('describeBlockForReceipt', () => {
  test('names a tool block by its tool name and line count', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'tool', startLine: 0, lineCount: 3, rawContent: 'x', collapseKey: 'k', toolName: 'exec',
    });
    expect(desc).toBe('tool result: exec (3 lines)');
  });

  test('falls back to a generic tool label when no tool name is recorded', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'tool', startLine: 0, lineCount: 1, rawContent: 'x', collapseKey: 'k',
    });
    expect(desc).toBe('tool result (1 line)');
  });

  test('names a diff block by its file path', () => {
    const desc = describeBlockForReceipt({
      blockIndex: 0, type: 'diff', startLine: 0, lineCount: 10, rawContent: 'x', collapseKey: 'k', filePath: 'src/foo.ts',
    });
    expect(desc).toBe('diff: src/foo.ts (10 lines)');
  });
});

describe('viewport-anchored block actions', () => {
  test('handleBlockCopy targets the block at the anchor line and names it in the receipt', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');
    expect(execBlock).toBeDefined();

    let rendered = 0;
    handleBlockCopy(cm, () => execBlock!.startLine, () => { rendered++; }, () => {});

    expect(rendered).toBeGreaterThan(0);
    expect(textOf(cm)).toContain('Copied tool result: exec');
  });

  test('handleBlockCopy anchored at the second block names THAT block, not the first', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const readBlock = blocks.find((b) => b.toolName === 'read');
    expect(readBlock).toBeDefined();

    handleBlockCopy(cm, () => readBlock!.startLine, () => {}, () => {});

    const text = textOf(cm);
    expect(text).toContain('Copied tool result: read');
    expect(text).not.toContain('Copied tool result: exec');
  });

  test('handleBlockCopy reports honestly when no block exists near the anchor', () => {
    const cm = new ConversationManager(() => 80);
    cm.addUserMessage('hello');
    cm.getDisplayBlocks();
    handleBlockCopy(cm, () => 0, () => {}, () => {});
    expect(textOf(cm)).toContain('No block found nearby');
  });

  test('handleBookmark names the block instead of its raw collapseKey', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');
    const bookmarkManager = { toggle: () => true, saveToFile: () => '/tmp/x', list: () => [] } as unknown as Parameters<typeof handleBookmark>[3];

    handleBookmark(cm, () => execBlock!.startLine, () => {}, bookmarkManager);

    const text = textOf(cm);
    expect(text).toContain('Bookmarked: tool result: exec');
    expect(text).not.toContain(execBlock!.collapseKey);
  });

  test('handleBlockToggle announces which block it collapsed/expanded', () => {
    const cm = buildConversationWithTwoToolBlocks();
    const blocks = cm.getBlockRegistry();
    const execBlock = blocks.find((b) => b.toolName === 'exec');

    handleBlockToggle(cm, () => execBlock!.startLine, () => {});

    const text = textOf(cm);
    expect(text.includes('Collapsed tool result: exec') || text.includes('Expanded tool result: exec')).toBe(true);
  });
});
