// ---------------------------------------------------------------------------
// conversation-fold.test.ts, the local fold adapter against the shared policy.
//
// src/core/conversation-fold.ts is deliberately a THREADING layer: it reads the
// product's own shapes (tool messages, RenderNode, collapse state) and hands
// the facts to @pellux/goodvibes-terminal-shell's conversation-fold-policy,
// which owns every decision. These tests import the policy DIRECTLY and assert
// the local wrappers answer identically, so if the adapter ever grows a
// decision of its own, or the policy changes underneath it, this fails rather
// than the two renderers drifting apart silently again.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  FOLDED_SHORT_CONTENT_CHARS,
  foldedToolResult,
  trailingBlankAfterRow,
} from '@pellux/goodvibes-terminal-shell';
import { isToolResultFolded, trailingBlankAfter } from '../../core/conversation-fold.ts';
import { summarizeToolResult } from '../../renderer/tool-result-summary.ts';
import type { RenderNode } from '../../core/conversation-turn-structure.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

type ToolMessage = Extract<ConversationMessageSnapshot, { role: 'tool' }>;

function toolMessage(toolName: string, content: string): ToolMessage {
  return { role: 'tool', callId: 'c1', toolName, content } as ToolMessage;
}

/** A long payload, comfortably past the policy's short-content threshold. */
const LONG = 'x'.repeat(FOLDED_SHORT_CONTENT_CHARS + 50);
/** A short payload with no summarizable shape. */
const SHORT = 'ok';
/** Short, but `read` parses it into a one-line summary ("read a.ts (12 lines)"). */
const SUMMARIZABLE = JSON.stringify({
  summary: { files_read: 1, total_lines: 12 },
  files: [{ path: '/tmp/a.ts' }],
});

const MESSAGE_FIXTURES: ReadonlyArray<readonly [string, ToolMessage]> = [
  ['long content, no summary', toolMessage('grep', LONG)],
  ['short content, no summary', toolMessage('grep', SHORT)],
  ['short content, summarizable', toolMessage('read', SUMMARIZABLE)],
  ['long content, summarizable', toolMessage('read', JSON.stringify({
    summary: { files_read: 1, total_lines: 12 },
    files: [{ path: '/tmp/b.ts' }],
    body: LONG,
  }))],
  ['no tool name', toolMessage('', LONG)],
  ['empty content', toolMessage('grep', '')],
];

const STORED_STATES: ReadonlyArray<readonly [string, boolean | undefined]> = [
  ['unset', undefined],
  ['stored collapsed', true],
  ['stored expanded', false],
];

describe('isToolResultFolded threads to the shared policy', () => {
  test('agrees with foldedToolResult on every fixture × stored-state pair', () => {
    for (const [label, message] of MESSAGE_FIXTURES) {
      for (const [stateLabel, stored] of STORED_STATES) {
        const collapseState = new Map<string, boolean>();
        if (stored !== undefined) collapseState.set('k', stored);

        const fromPolicy = foldedToolResult({
          contentLength: message.content.length,
          hasSummary: summarizeToolResult(message.toolName, message.content) !== null,
          storedCollapsed: stored,
        });

        expect(
          isToolResultFolded(message, collapseState, 'k'),
          `${label} / ${stateLabel}`,
        ).toBe(fromPolicy);
      }
    }
  });

  // Pins the behaviour itself, so parity alone cannot pass while both sides are
  // wrong together.
  test('the answers are the ones the transcript actually needs', () => {
    const unset = new Map<string, boolean>();
    expect(isToolResultFolded(toolMessage('grep', LONG), unset, 'k')).toBe(true);
    expect(isToolResultFolded(toolMessage('grep', SHORT), unset, 'k')).toBe(false);
    // A summarizable result folds even though it is short: the summary is the
    // better row.
    expect(summarizeToolResult('read', SUMMARIZABLE)).not.toBeNull();
    expect(isToolResultFolded(toolMessage('read', SUMMARIZABLE), unset, 'k')).toBe(true);
    // A stored expansion wins over the fold default.
    expect(isToolResultFolded(toolMessage('grep', LONG), new Map([['k', false]]), 'k')).toBe(false);
  });
});

function node(kind: 'message' | 'toolcall', depth: number, message: ConversationMessageSnapshot): RenderNode {
  return {
    id: `n${depth}`,
    kind,
    absIdx: 0,
    depth,
    message,
    scope: '',
    openAncestorDepths: [],
  } as RenderNode;
}

const ASSISTANT = { role: 'assistant', content: 'answer' } as ConversationMessageSnapshot;

describe('trailingBlankAfter threads to the shared policy', () => {
  test('agrees with trailingBlankAfterRow across the row-shape fixtures', () => {
    const foldedRow = node('message', 1, toolMessage('grep', LONG));
    const context = { assistantTurns: undefined, collapseState: new Map<string, boolean>() };

    const nextFixtures: ReadonlyArray<readonly [string, RenderNode | undefined]> = [
      ['end of transcript', undefined],
      ['branch row under the same unit', node('message', 1, toolMessage('grep', LONG))],
      ['top-level tool call', node('toolcall', 0, ASSISTANT)],
      ['top-level tool result', node('message', 0, toolMessage('grep', LONG))],
      ['top-level prose', node('message', 0, ASSISTANT)],
    ];

    for (const [label, next] of nextFixtures) {
      const fromPolicy = trailingBlankAfterRow({
        nextIsBranchRow: next !== undefined && next.depth !== 0,
        nextIsToolMachinery: next !== undefined
          && (next.kind === 'toolcall' || next.message.role === 'tool'),
        rowRendersFolded: true,
      });
      expect(trailingBlankAfter(foldedRow, next, context), label).toBe(fromPolicy);
    }
  });

  test('a folded row butts against the next tool row, but keeps its blank before prose', () => {
    const foldedRow = node('message', 1, toolMessage('grep', LONG));
    const context = { assistantTurns: undefined, collapseState: new Map<string, boolean>() };

    expect(trailingBlankAfter(foldedRow, node('toolcall', 0, ASSISTANT), context)).toBe(false);
    expect(trailingBlankAfter(foldedRow, node('message', 0, ASSISTANT), context)).toBe(true);
    expect(trailingBlankAfter(foldedRow, undefined, context)).toBe(true);
  });
});
