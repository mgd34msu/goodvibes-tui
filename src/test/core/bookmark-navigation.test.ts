// ---------------------------------------------------------------------------
// bookmark-navigation.test.ts, fallback resolution for a bookmark whose
// direct BlockMeta lookup misses because it targets a folded (non-owning)
// member of a currently-collapsed tool-result group (see
// conversation-turn-structure.ts). A folded member pushes no BlockMeta of its
// own, so `getBlockRegistry().find(b => b.collapseKey === key)`, the direct
// lookup jumpToBookmark (src/main.ts) tries first, reports nothing even
// though the message is still present, just folded under its group header.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { resolveFoldedBookmarkLine } from '../../core/bookmark-navigation.ts';

describe('resolveFoldedBookmarkLine', () => {
  test('resolves a folded group member\'s own msg_<idx> key to its group header line', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('read and write two files');       // absolute index 0
    cm.addAssistantMessage('reading and writing now', {  // absolute index 1
      toolCalls: [
        { id: 'call-1', name: 'Read', arguments: { path: 'foo.ts' } },
        { id: 'call-2', name: 'Write', arguments: { path: 'bar.ts' } },
      ],
    });
    cm.addToolResults([                                   // absolute indexes 2, 3
      { callId: 'call-1', success: true, output: 'contents of foo.ts' },
      { callId: 'call-2', success: true, output: 'wrote bar.ts' },
    ]);
    cm.getDisplayBlocks(); // warm
    // Turns default EXPANDED (collapsing must never hide prose), so the
    // hidden-member condition this test is about is created explicitly.
    cm.setCollapsed('turn_1', true);
    cm.getDisplayBlocks();

    const groupBlock = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(groupBlock).toBeDefined();

    // A bookmark stored on the SECOND tool message's own collapseKey
    // (absolute index 3, the non-owning member), this key is not in the
    // block registry at all while the group is folded.
    expect(cm.getBlockRegistry().find((b) => b.collapseKey === 'msg_3')).toBeUndefined();

    const resolved = resolveFoldedBookmarkLine(cm, 'msg_3');
    expect(resolved).toBe(groupBlock!.startLine);
  });

  test('a bookmark on the owning (first) member resolves to the same group header line', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('read and write two files');
    cm.addAssistantMessage('reading and writing now', {
      toolCalls: [
        { id: 'call-1', name: 'Read', arguments: { path: 'foo.ts' } },
        { id: 'call-2', name: 'Write', arguments: { path: 'bar.ts' } },
      ],
    });
    cm.addToolResults([
      { callId: 'call-1', success: true, output: 'contents of foo.ts' },
      { callId: 'call-2', success: true, output: 'wrote bar.ts' },
    ]);
    cm.getDisplayBlocks();
    cm.setCollapsed('turn_1', true);
    cm.getDisplayBlocks();

    const groupBlock = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(resolveFoldedBookmarkLine(cm, 'msg_2')).toBe(groupBlock!.startLine);
  });

  test('a non-message key returns null (not a fallback candidate)', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('hello');
    expect(resolveFoldedBookmarkLine(cm, 'code_0_1')).toBeNull();
    expect(resolveFoldedBookmarkLine(cm, 'group_5')).toBeNull();
  });

  test('a msg_<idx> key past the end of the conversation returns null', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('hello');
    expect(resolveFoldedBookmarkLine(cm, 'msg_999')).toBeNull();
  });
});
