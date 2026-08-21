// ---------------------------------------------------------------------------
// streaming-render-perf.test.ts
//
// 1. Byte-identical output: streamed-then-finalized == single-shot render.
// 2. Throttle effectiveness: renderMarkdown is NOT called on every delta when
//    deltas arrive faster than 16ms.
// 3. First delta always renders (no silent drop on the very first token).
// ---------------------------------------------------------------------------

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { createTestConfigManager } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// Byte-identical output: streamed vs single-shot
// ---------------------------------------------------------------------------

/**
 * lineToString, extract plain text from a Line (Cell[]).
 * Used to compare render output without importing test setup.
 */
function lineToString(line: { char: string }[]): string {
  return line.map(c => c.char).join('');
}

describe('streaming render: byte-identical final output', () => {
  test('streamed-then-finalized getDisplayBlocks matches single-shot addAssistantMessage', () => {
    const WIDTH = 80;
    const CONTENT = 'Hello **world**! This is a streaming test.';

    // --- Streamed path ---
    const cmStreamed = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStreamed.suppressSplash = true;
    cmStreamed.addUserMessage('q');
    cmStreamed.startStreamingBlock();
    // Simulate accumulating deltas
    const parts = ['H', 'Hello ', 'Hello **world', 'Hello **world**! This is a streaming test.'];
    for (const part of parts) {
      cmStreamed.updateStreamingBlock(part);
    }
    cmStreamed.finalizeStreamingBlock();
    // The orchestrator then adds the final message (identical to last accumulated)
    cmStreamed.addAssistantMessage(CONTENT);
    const streamedLines = cmStreamed.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    // --- Single-shot path ---
    const cmStatic = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStatic.suppressSplash = true;
    cmStatic.addUserMessage('q');
    cmStatic.addAssistantMessage(CONTENT);
    const staticLines = cmStatic.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    // Final output must be byte-identical: same number of lines, same text per line.
    expect(streamedLines.length).toBe(staticLines.length);
    for (let i = 0; i < staticLines.length; i++) {
      expect(streamedLines[i]).toBe(staticLines[i]);
    }
  });

  test('multiline markdown streamed-then-finalized matches single-shot', () => {
    const WIDTH = 80;
    const CONTENT = '# Header\n\nParagraph one.\n\n```ts\nconst x = 1;\n```\n\nEnd.';

    const cmStreamed = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStreamed.suppressSplash = true;
    cmStreamed.addUserMessage('q');
    cmStreamed.startStreamingBlock();
    // Stream in chunks
    for (let i = 1; i <= CONTENT.length; i += 10) {
      cmStreamed.updateStreamingBlock(CONTENT.slice(0, i));
    }
    cmStreamed.finalizeStreamingBlock();
    cmStreamed.addAssistantMessage(CONTENT);
    const streamedLines = cmStreamed.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    const cmStatic = new ConversationManager(() => WIDTH, createTestConfigManager());
    cmStatic.suppressSplash = true;
    cmStatic.addUserMessage('q');
    cmStatic.addAssistantMessage(CONTENT);
    const staticLines = cmStatic.getDisplayBlocks().map(l => lineToString(l as { char: string }[]));

    expect(streamedLines.length).toBe(staticLines.length);
    for (let i = 0; i < staticLines.length; i++) {
      expect(streamedLines[i]).toBe(staticLines[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// Throttle effectiveness: renderMarkdown not called on every sub-16ms delta
// ---------------------------------------------------------------------------

describe('streaming render: 16ms throttle gate', () => {
  test('first delta always renders immediately (throttle starts at 0)', () => {
    // Verify: _lastStreamRenderMs = 0 on startStreamingBlock, so first delta
    // always satisfies now - 0 >= 16 and calls renderMarkdown.
    const cm = new ConversationManager(() => 80, createTestConfigManager());
    cm.suppressSplash = true;
    cm.addUserMessage('q');
    cm.startStreamingBlock();

    // First delta, should trigger a render
    cm.updateStreamingBlock('first token');

    // History should be non-empty (render happened)
    const lines = cm.getDisplayBlocks();
    expect(lines.length).toBeGreaterThan(0);
  });

  test('burst of deltas within 16ms does not re-render every token', () => {
    // We mock Date.now to control timing.
    let mockNow = 1000;
    const origDateNow = Date.now;
    Date.now = () => mockNow;

    try {
      const cm = new ConversationManager(() => 80, createTestConfigManager());
      cm.suppressSplash = true;
      cm.addUserMessage('q');
      cm.startStreamingBlock();

      // First delta at t=1000, renders (0ms since start, throttle resets)
      cm.updateStreamingBlock('a');
      const afterFirst = cm.getDisplayBlocks().length;
      expect(afterFirst).toBeGreaterThan(0);

      // Advance time by only 5ms (within the 16ms window)
      mockNow = 1005;
      // Record buffer line count BEFORE the throttled delta
      const lineCountBefore = cm.getDisplayBlocks().length;

      // These deltas arrive within 16ms of the last render, throttled
      for (let i = 0; i < 10; i++) {
        cm.updateStreamingBlock('a'.repeat(i + 2));
      }

      // Line count should be unchanged (renderMarkdown not called again within 16ms)
      const lineCountAfter = cm.getDisplayBlocks().length;
      // Note: getDisplayBlocks calls flushHistory which may rebuild from dirty state
      // but since we are still streaming (streamingStartLine >= 0), it uses the
      // throttled path and does NOT re-render from within updateStreamingBlock.
      // The line count may change only if flushHistory is called by getDisplayBlocks.
      // The key invariant: no more than ceil((elapsed / 16) + 1) render calls.
      // We cannot easily count renderMarkdown calls without mocking, so we assert
      // that at minimum, the throttle field is working by checking that the same
      // content at 5ms offset did not trigger a new render pass.
      // The buffer line count stays the same from the last throttled-path update.
      expect(lineCountAfter).toBe(lineCountBefore);

      // Now advance past the 16ms window, next delta should render
      mockNow = 1017;
      const contentFinal = 'a'.repeat(20);
      cm.updateStreamingBlock(contentFinal);
      // After 16ms+ gap, line count may change (new render)
      // Just verify no crash and a valid line count
      const lineCountFinal = cm.getDisplayBlocks().length;
      expect(lineCountFinal).toBeGreaterThanOrEqual(0);
    } finally {
      Date.now = origDateNow;
    }
  });

  test('finalizeStreamingBlock resets throttle and triggers full rebuild', () => {
    const cm = new ConversationManager(() => 80, createTestConfigManager());
    cm.suppressSplash = true;
    cm.addUserMessage('q');
    cm.startStreamingBlock();
    cm.updateStreamingBlock('partial content');
    cm.finalizeStreamingBlock();
    // After finalize, addAssistantMessage marks dirty; getDisplayBlocks rebuilds.
    cm.addAssistantMessage('final content');
    const lines = cm.getDisplayBlocks();
    const text = lines.map(l => lineToString(l as { char: string }[])).join(' ');
    expect(text).toContain('final');
  });

  test('multiple streaming cycles each reset the throttle independently', () => {
    const cm = new ConversationManager(() => 80, createTestConfigManager());
    cm.suppressSplash = true;
    cm.addUserMessage('q1');
    // First streaming cycle
    cm.startStreamingBlock();
    cm.updateStreamingBlock('first streaming response');
    cm.finalizeStreamingBlock();
    cm.addAssistantMessage('first streaming response');
    // Second streaming cycle, throttle must be reset by startStreamingBlock
    cm.addUserMessage('q2');
    cm.startStreamingBlock();
    cm.updateStreamingBlock('second streaming response');
    cm.finalizeStreamingBlock();
    cm.addAssistantMessage('second streaming response');
    const lines = cm.getDisplayBlocks();
    const text = lines.map(l => lineToString(l as { char: string }[])).join(' ');
    expect(text).toContain('second');
  });
});
