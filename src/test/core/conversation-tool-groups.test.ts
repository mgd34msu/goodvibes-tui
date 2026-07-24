// ---------------------------------------------------------------------------
// conversation-tool-groups.test.ts — membership detection for folded runs of
// tool-result messages (see src/core/conversation-tool-groups.ts).
//
// Covers: a run of >=2 matching tool results groups; a single result does not;
// an interleaved non-tool message breaks the run; a callId not present in the
// assistant's own toolCalls set excludes that message from the run; index
// offsets (sliced message arrays) are honored; the honest tool/line counts
// buildToolGroupMembership attaches to each member.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  detectToolGroups,
  computeToolGroupMembership,
} from '../../core/conversation-tool-groups.ts';
import { renderExpandedToolResultLines } from '../../renderer/tool-result-expanded-lines.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

const WIDTH = 80;

/** Expected post-render line count for one or more tool-result bodies at
 *  WIDTH — mirrors what buildToolGroupMembership sums for `totalLines`, so
 *  these tests assert the real invariant (matches the render) rather than a
 *  hand-computed magic number that would silently drift from the renderer. */
function expectedLines(...contents: string[]): number {
  return contents.reduce((sum, content) => sum + renderExpandedToolResultLines(content, WIDTH).length, 0);
}

type Message = ConversationMessageSnapshot;

function assistantWithTools(ids: string[]): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'exec', arguments: {} })),
  };
}

function toolResult(callId: string, content = 'ok'): Message {
  return { role: 'tool', callId, content, toolName: 'exec' };
}

function userMsg(content = 'hi'): Message {
  return { role: 'user', content };
}

describe('detectToolGroups', () => {
  test('groups >=2 consecutive matching tool results under one assistant turn', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a'),
      toolResult('b'),
    ];
    expect(detectToolGroups(messages, 0)).toEqual([
      { assistantIdx: 0, toolMessageIndexes: [1, 2] },
    ]);
  });

  test('a single result is not grouped', () => {
    const messages: Message[] = [
      assistantWithTools(['a']),
      toolResult('a'),
    ];
    expect(detectToolGroups(messages, 0)).toEqual([]);
  });

  test('a run of 3 groups fully, and stops at the following non-matching message', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b', 'c']),
      toolResult('a'),
      toolResult('b'),
      toolResult('c'),
      userMsg('thanks'),
    ];
    expect(detectToolGroups(messages, 0)).toEqual([
      { assistantIdx: 0, toolMessageIndexes: [1, 2, 3] },
    ]);
  });

  test('an interleaved non-tool message breaks the run before it reaches 2 members', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a'),
      userMsg('hold on'),
      toolResult('b'),
    ];
    // Only 'a' is consecutive to the assistant turn; the user message stops
    // the run at 1 matched result, which is below the >=2 threshold.
    expect(detectToolGroups(messages, 0)).toEqual([]);
  });

  test('an interleaved non-tool message still allows a group when 2 matches land before it', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b', 'c']),
      toolResult('a'),
      toolResult('b'),
      userMsg('thanks'),
      toolResult('c'),
    ];
    // The run stops at the user message with 2 matched results already
    // collected — that's a group; the later, non-consecutive 'c' result is
    // NOT included (it isn't part of the consecutive run).
    expect(detectToolGroups(messages, 0)).toEqual([
      { assistantIdx: 0, toolMessageIndexes: [1, 2] },
    ]);
  });

  test('a callId not present in the assistant toolCalls set excludes that message from the run', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a'),
      toolResult('unrelated-call'),
    ];
    // The run stops at the mismatched callId with only 1 matched result.
    expect(detectToolGroups(messages, 0)).toEqual([]);
  });

  test('an assistant message with no toolCalls never starts a group', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'no tools here' },
      toolResult('a'),
      toolResult('b'),
    ];
    expect(detectToolGroups(messages, 0)).toEqual([]);
  });

  test('honors an index offset for sliced message arrays', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a'),
      toolResult('b'),
    ];
    expect(detectToolGroups(messages, 10)).toEqual([
      { assistantIdx: 10, toolMessageIndexes: [11, 12] },
    ]);
  });
});

describe('computeToolGroupMembership', () => {
  test('marks the first member and computes honest tool/line counts', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a', 'line one\nline two'), // 2 lines
      toolResult('b', 'single line'),          // 1 line
    ];
    const membership = computeToolGroupMembership(messages, 0, WIDTH);
    const totalLines = expectedLines('line one\nline two', 'single line');
    expect(membership.get(1)).toEqual({ groupKey: 'group_0', isFirst: true, toolCount: 2, totalLines, toolNames: ['exec', 'exec'], memberIndexes: [1, 2] });
    expect(membership.get(2)).toEqual({ groupKey: 'group_0', isFirst: false, toolCount: 2, totalLines, toolNames: ['exec', 'exec'], memberIndexes: [1, 2] });
    // The assistant message itself is never a membership key.
    expect(membership.has(0)).toBe(false);
  });

  test('the "N lines" total matches what expanding every member actually renders, not raw content length', () => {
    // A JSON blob is one raw line but pretty-prints to several once expanded —
    // the group total must count the expanded form, matching each member's
    // own badge (see conversation-rendering.ts / tool-result-expanded-lines.ts).
    const jsonContent = JSON.stringify({ a: 1, b: 2, c: 3 });
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a', jsonContent),
      toolResult('b', 'plain'),
    ];
    const membership = computeToolGroupMembership(messages, 0, WIDTH);
    const expected = expectedLines(jsonContent, 'plain');
    expect(expected).toBeGreaterThan(2); // sanity: the JSON really did expand past 1 raw line
    expect(membership.get(1)?.totalLines).toBe(expected);
  });

  test('deduplicates tool names with counts for the group header summary', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [
        { id: 'a', name: 'read', arguments: {} },
        { id: 'b', name: 'read', arguments: {} },
        { id: 'c', name: 'exec', arguments: {} },
      ] },
      { role: 'tool', callId: 'a', content: 'x', toolName: 'read' },
      { role: 'tool', callId: 'b', content: 'y', toolName: 'read' },
      { role: 'tool', callId: 'c', content: 'z', toolName: 'exec' },
    ];
    const membership = computeToolGroupMembership(messages, 0, WIDTH);
    expect(membership.get(1)?.toolNames).toEqual(['read', 'read', 'exec']);
  });

  test('an ungrouped (single-result) run produces no membership entries', () => {
    const messages: Message[] = [
      assistantWithTools(['a']),
      toolResult('a'),
    ];
    expect(computeToolGroupMembership(messages, 0, WIDTH).size).toBe(0);
  });

  test('two separate assistant turns produce two independently-keyed groups', () => {
    const messages: Message[] = [
      assistantWithTools(['a', 'b']),
      toolResult('a'),
      toolResult('b'),
      assistantWithTools(['c', 'd']),
      toolResult('c'),
      toolResult('d'),
    ];
    const membership = computeToolGroupMembership(messages, 0, WIDTH);
    expect(membership.get(1)?.groupKey).toBe('group_0');
    expect(membership.get(2)?.groupKey).toBe('group_0');
    expect(membership.get(4)?.groupKey).toBe('group_3');
    expect(membership.get(5)?.groupKey).toBe('group_3');
  });
});
