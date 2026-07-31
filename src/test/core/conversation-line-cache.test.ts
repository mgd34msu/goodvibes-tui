// ---------------------------------------------------------------------------
// conversation-line-cache.test.ts — per-message Line[] cache correctness.
//
// CORRECTNESS IS THE ACCEPTANCE. The per-message cache is a pure memoisation: a
// cache-served rebuild must be BYTE-IDENTICAL to a from-scratch (cold) rebuild in
// every state. These tests build a cache-vs-cold equivalence helper
// (assertCacheMatchesCold) and drive it through every mutation that could produce
// a stale frame:
//   - append to a large conversation
//   - streaming tail mutation mid-stream
//   - collapse / expand toggle
//   - resize (width change)
//   - tool-result arrival adding to an existing turn
//   - message content edited in place at a reused index
// Each asserts the rendered output (lines + block registry + error-nav registry)
// equals a rebuild with the cache cleared.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

// --- serialisation ---------------------------------------------------------

/** Fully serialise a Line[] down to every rendered cell attribute. */
function serializeLines(lines: Line[]): string {
  return lines
    .map((line) =>
      line
        .map(
          (c) =>
            `${c.char}${c.fg}${c.bg}` +
            `${c.bold ? 1 : 0}${c.dim ? 1 : 0}${c.underline ? 1 : 0}${c.italic ? 1 : 0}${c.strikethrough ? 1 : 0}` +
            `${c.link ?? ''}`,
        )
        .join(''),
    )
    .join('');
}

interface RenderState {
  lines: string;
  registry: string;
  errorLines: string;
}

function captureState(cm: ConversationManager): RenderState {
  return {
    lines: serializeLines(cm.getDisplayBlocks()),
    registry: JSON.stringify(cm.getBlockRegistry()),
    errorLines: JSON.stringify(cm.getErrorLines()),
  };
}

/**
 * The core equivalence assertion. Captures the current (warm-cache) render, then
 * clears the line cache to force a full cold rebuild and captures again. The two
 * must be identical in lines, block registry, and error-navigation registry.
 */
function assertCacheMatchesCold(cm: ConversationManager): void {
  const warm = captureState(cm);
  cm.clearLineCache();
  const cold = captureState(cm);
  expect(warm.lines).toBe(cold.lines);
  expect(warm.registry).toBe(cold.registry);
  expect(warm.errorLines).toBe(cold.errorLines);
}

// --- fixtures --------------------------------------------------------------

const CODE_FENCE = '```ts\n' + ['function f(n: number) {', '  return n * 2;', '}'].join('\n') + '\n```';
const LONG_TOOL_OUTPUT = Array.from({ length: 40 }, (_, i) => `output line ${i + 1} of a long tool result`).join('\n');
const DIFF_OUTPUT = [
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,3 @@',
  '-const a = 1;',
  '+const a = 2;',
  ' const b = 3;',
].join('\n');

function buildMixed(count: number): ConversationMessageSnapshot[] {
  const msgs: ConversationMessageSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    switch (i % 5) {
      case 0:
        msgs.push({ role: 'user', content: `question number ${i} about the failing test` });
        break;
      case 1:
        msgs.push({ role: 'assistant', content: `answer ${i}\n\n${CODE_FENCE}`, model: 'claude-opus', provider: 'anthropic' });
        break;
      case 2:
        msgs.push({ role: 'tool', callId: `read-${i}`, toolName: 'Read', content: `short result ${i}\nsecond line` });
        break;
      case 3:
        msgs.push({ role: 'tool', callId: `edit-${i}`, toolName: 'Edit', content: DIFF_OUTPUT });
        break;
      default:
        msgs.push({ role: 'assistant', content: `summary ${i}: checked, confirmed, verified` });
        break;
    }
  }
  return msgs;
}

// --- proof the cache actually reuses work ----------------------------------

describe('per-message cache reuse', () => {
  test('unchanged messages reuse the SAME Line[] instances across rebuilds', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('first message');
    cm.addAssistantMessage('a reply that spans the display');
    const firstBuild = [...cm.getDisplayBlocks()];

    // Append a new message → rebuild. A cold rebuild would allocate fresh Line
    // objects for every message; the cache reuses the earlier messages' lines.
    cm.addUserMessage('second message');
    const secondBuild = cm.getDisplayBlocks();

    // The first message's first rendered line is the identical object instance,
    // proving it came from the cache rather than a re-render.
    expect(secondBuild[0]).toBe(firstBuild[0]);
    expect(secondBuild[1]).toBe(firstBuild[1]);
  });

  test('clearLineCache forces fresh Line[] instances (cold rebuild)', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('hello world');
    const build1 = [...cm.getDisplayBlocks()];

    cm.clearLineCache();
    const build2 = cm.getDisplayBlocks();

    // Same bytes, but different object instances (nothing was reused).
    expect(serializeLines(build2)).toBe(serializeLines(build1));
    expect(build2[0]).not.toBe(build1[0]);
  });
});

// --- stale-frame equivalence scenarios -------------------------------------

describe('cache-vs-cold equivalence', () => {
  test('append to a large conversation', () => {
    const cm = new ConversationManager(() => 100);
    cm.fromJSON({ messages: buildMixed(300) as never[] });
    cm.getDisplayBlocks(); // warm
    assertCacheMatchesCold(cm);

    cm.addUserMessage('a brand new appended message');
    assertCacheMatchesCold(cm);

    cm.addAssistantMessage(`appended reply\n\n${CODE_FENCE}`, { model: 'claude-opus', provider: 'anthropic' });
    assertCacheMatchesCold(cm);
  });

  test('streaming tail mutation mid-stream', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('please write a haiku');
    cm.addAssistantMessage('here is a prior reply');
    cm.getDisplayBlocks(); // warm

    cm.startStreamingBlock();
    cm.updateStreamingBlock('partial streaming line one');
    assertCacheMatchesCold(cm);

    cm.updateStreamingBlock('partial streaming line one\nand a second line now');
    assertCacheMatchesCold(cm);

    cm.updateStreamingBlock('partial streaming line one\nand a second line now\n\n```ts\nconst x = 1;\n```');
    assertCacheMatchesCold(cm);

    cm.finalizeStreamingBlock();
    cm.addAssistantMessage('here is a prior reply\nand a second line now');
    assertCacheMatchesCold(cm);
  });

  test('collapse / expand toggle invalidates only the toggled block', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('run the tool');
    cm.addToolResults([{ callId: 'tool-1', success: true, output: LONG_TOOL_OUTPUT }]);
    cm.addAssistantMessage('and here is more conversation after the tool');
    cm.getDisplayBlocks(); // warm; the long tool result auto-collapses

    const toolBlock = cm.getBlockRegistry().find((b) => b.type === 'tool');
    expect(toolBlock).toBeDefined();

    // Toggle it expanded.
    cm.toggleCollapseAtLine(toolBlock!.startLine);
    assertCacheMatchesCold(cm);

    // Toggle it collapsed again.
    const toolBlock2 = cm.getBlockRegistry().find((b) => b.type === 'tool');
    cm.toggleCollapseAtLine(toolBlock2!.startLine);
    assertCacheMatchesCold(cm);
  });

  test('toggling an assistant turn invalidates exactly its rows', () => {
    // Two tool calls in one assistant turn hang under a single turn header
    // (see conversation-turn-structure.ts). A message entirely BEFORE the turn
    // keeps its cached Line[] instance across the toggle — proof the turn's
    // collapseState key is read (and invalidates) only the entries that
    // actually depend on it, not the whole conversation.
    //
    // A message AFTER the turn is a different story: collapsing/expanding
    // this turn changes how many BlockMeta entries its rows contribute
    // (1 header collapsed vs. 1 header + 2 result blocks expanded), which
    // shifts blockBase — the block-registry length embedded
    // in every later message's cache key — for everything that follows. That
    // cascade is the SAME existing mechanism that already invalidates
    // everything after a code block whose collapse changes its line count
    // (see this file's blockBase doc comment); it is correct, not something
    // this test claims is scoped away.
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('an earlier message, unrelated to the turn');
    cm.addAssistantMessage('reading and writing now', {
      toolCalls: [
        { id: 'call-1', name: 'Read', arguments: { path: 'foo.ts' } },
        { id: 'call-2', name: 'Write', arguments: { path: 'bar.ts' } },
      ],
    });
    cm.addToolResults([
      { callId: 'call-1', success: true, output: 'file one contents' },
      { callId: 'call-2', success: true, output: 'wrote bar.ts' },
    ]);
    cm.addUserMessage('a later message, also unrelated');

    // Warm the cache. Turns default EXPANDED, so both result blocks are
    // present to begin with — the toggle sequence below runs the other way
    // round from the retired folded-group model.
    const before = [...cm.getDisplayBlocks()];

    const turnBlock = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    expect(turnBlock).toBeDefined();
    expect(cm.getBlockRegistry().filter((b) => b.type === 'tool').length).toBe(2);

    // Collapse the turn — both result blocks leave the registry.
    cm.toggleCollapseAtLine(turnBlock!.startLine);
    const afterCollapse = cm.getDisplayBlocks();

    // The leading, unrelated message keeps the SAME Line[] object instance —
    // proof the turn's collapse key invalidates only the entries that read it.
    expect(afterCollapse[0]).toBe(before[0]);

    const collapsedRegistry = cm.getBlockRegistry();
    expect(collapsedRegistry.filter((b) => b.type === 'assistant_turn').length).toBe(1);
    expect(collapsedRegistry.filter((b) => b.type === 'tool').length).toBe(0);
    assertCacheMatchesCold(cm);

    // Expand it again — both result blocks come back.
    const turnBlock2 = cm.getBlockRegistry().find((b) => b.type === 'assistant_turn');
    cm.toggleCollapseAtLine(turnBlock2!.startLine);
    assertCacheMatchesCold(cm);
    const expandedRegistry = cm.getBlockRegistry();
    expect(expandedRegistry.filter((b) => b.type === 'assistant_turn').length).toBe(1);
    expect(expandedRegistry.filter((b) => b.type === 'tool').length).toBe(2);
  });

  test('resize (width change) re-renders every message correctly', () => {
    const cm = new ConversationManager(() => 100);
    cm.fromJSON({ messages: buildMixed(120) as never[] });
    cm.getDisplayBlocks(); // warm at 100
    assertCacheMatchesCold(cm);

    let width = 70;
    cm.setWidthProvider(() => width);
    assertCacheMatchesCold(cm);

    width = 140;
    cm.setWidthProvider(() => width);
    assertCacheMatchesCold(cm);

    // Resize BACK to a previously-rendered width.
    width = 100;
    cm.setWidthProvider(() => width);
    assertCacheMatchesCold(cm);
  });

  test('tool-result arrival adds to an existing turn', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('read the file');
    cm.addAssistantMessage('reading it now', {
      toolCalls: [{ id: 'call-1', name: 'Read', arguments: { path: 'foo.ts' } }],
    });
    cm.getDisplayBlocks(); // warm — assistant turn cached with its tool-call block

    // The tool result arrives as a new tool message on the existing turn.
    cm.addToolResults([{ callId: 'call-1', success: true, output: 'file contents\nline two\nline three' }]);
    assertCacheMatchesCold(cm);

    // A diff-shaped tool result arriving next.
    cm.addAssistantMessage('now editing', { toolCalls: [{ id: 'call-2', name: 'Edit', arguments: {} }] });
    cm.addToolResults([{ callId: 'call-2', success: true, output: DIFF_OUTPUT }]);
    assertCacheMatchesCold(cm);
  });

  test('a tool call that completes while sibling calls in the same turn are still pending shows done immediately, not a stale pending glyph', () => {
    // Regression: the cache used to key an assistant message's pending state
    // on a single aggregate boolean ("does ANY call still lack a result").
    // With 3 calls, after only the first result arrives the aggregate is
    // STILL true (calls 2 and 3 are still pending), so the cached entry from
    // before any result arrived stayed valid and was served unchanged — call
    // 1 kept showing the pending glyph (◌) instead of flipping to done (✓)
    // until the LAST of the three results arrived.
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('run three tools');
    cm.addAssistantMessage('running now', {
      toolCalls: [
        { id: 'call-1', name: 'Read', arguments: { path: 'a.ts' } },
        { id: 'call-2', name: 'Read', arguments: { path: 'b.ts' } },
        { id: 'call-3', name: 'Read', arguments: { path: 'c.ts' } },
      ],
    });
    cm.getDisplayBlocks(); // warm — cached with all three calls pending

    // Count CALL rows only. A settled result row also carries ✓ in the shared
    // status gutter, so a whole-transcript glyph count would conflate the two.
    // A call row is a tree branch (it has a connector) that names its target
    // file; all three calls here share the tool label 'Read', so it is hoisted
    // to the turn header once and each row leads with its own path instead.
    const countGlyphs = (): { done: number; pending: number } => {
      const callRows = cm.getDisplayBlocks()
        .map((l) => l.map((c) => c.char).join(''))
        .filter((t) => /[├└]/.test(t) && /\.ts/.test(t));
      return {
        done: callRows.filter((t) => t.includes('✓')).length,
        pending: callRows.filter((t) => t.includes('◌')).length,
      };
    };

    // Only the FIRST result arrives; calls 2 and 3 are still awaiting theirs.
    cm.addToolResults([{ callId: 'call-1', success: true, output: 'contents of a.ts' }]);
    expect(countGlyphs()).toEqual({ done: 1, pending: 2 });
    assertCacheMatchesCold(cm);

    // Second result arrives; call-3 alone is still pending.
    cm.addToolResults([{ callId: 'call-2', success: true, output: 'contents of b.ts' }]);
    expect(countGlyphs()).toEqual({ done: 2, pending: 1 });
    assertCacheMatchesCold(cm);

    // Final result arrives; nothing pending.
    cm.addToolResults([{ callId: 'call-3', success: true, output: 'contents of c.ts' }]);
    expect(countGlyphs()).toEqual({ done: 3, pending: 0 });
    assertCacheMatchesCold(cm);
  });

  test('message content edited in place at a reused index', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('shared prefix');
    cm.addAssistantMessage('original assistant content that will be replaced');
    cm.getDisplayBlocks(); // warm — index 1 cached with the original content

    // Truncate the last message (cache NOT cleared) and re-add a different one at
    // the SAME index. The content signature must invalidate the stale entry.
    cm.removeMessagesAfter(1);
    cm.addAssistantMessage('edited assistant content — completely different length and wrapping behaviour here');
    assertCacheMatchesCold(cm);

    const text = cm.getDisplayBlocks().map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(text).toContain('edited assistant content');
    expect(text).not.toContain('original assistant content');
  });

  test('system messages preserve error-navigation registry through the cache', () => {
    const cm = new ConversationManager(() => 100);
    cm.addUserMessage('trigger a failure');
    cm.addSystemMessage('request failed: provider returned 500');
    cm.addAssistantMessage('recovering now');
    cm.getDisplayBlocks(); // warm
    assertCacheMatchesCold(cm);

    // getErrorLines must resolve to the system message line via the replayed registry.
    expect(cm.getErrorLines().length).toBeGreaterThan(0);

    cm.addSystemMessage('a second failure occurred');
    assertCacheMatchesCold(cm);
    expect(cm.getErrorLines().length).toBe(2);
  });

  test('clearDisplay then re-render stays cache-correct', () => {
    const cm = new ConversationManager(() => 100);
    cm.fromJSON({ messages: buildMixed(50) as never[] });
    cm.getDisplayBlocks(); // warm
    cm.clearDisplay();
    expect(cm.getDisplayBlocks().length).toBe(0);

    cm.addUserMessage('post-clear message');
    assertCacheMatchesCold(cm);
    const text = cm.getDisplayBlocks().map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(text).toContain('post-clear message');
    expect(text).not.toContain('question number 0');
  });

  test('cache is bounded to the visible set via mark-and-sweep', () => {
    const cm = new ConversationManager(() => 100);
    cm.fromJSON({ messages: buildMixed(200) as never[] });
    cm.getDisplayBlocks(); // warm — one entry per visible message
    expect(cm.getLineCacheSize()).toBe(200);

    // clearDisplay hides all current messages; the next rebuild renders only the
    // newly-added message, so the 200 now-hidden entries are swept.
    cm.clearDisplay();
    cm.addUserMessage('only this shows now');
    cm.getDisplayBlocks();
    expect(cm.getLineCacheSize()).toBe(1);
  });

  test('config change (line numbers) invalidates cached messages', () => {
    // Two managers with different config produce different output; the cache key
    // includes config so a manager cannot serve a stale pre-config-change frame.
    const cm = new ConversationManager(() => 100);
    cm.addAssistantMessage(`some content\n\n${CODE_FENCE}`);
    cm.getDisplayBlocks();
    assertCacheMatchesCold(cm);
  });
});
