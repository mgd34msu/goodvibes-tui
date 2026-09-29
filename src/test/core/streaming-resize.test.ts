import { describe, test, expect } from 'bun:test';
import { ConversationManager } from '../../core/conversation';
import { renderStreamingContinuation } from '../../core/work-tree-render.ts';
import { createTestConfigManager } from '../helpers/test-managers.ts';

// ---------------------------------------------------------------------------
// Regression: terminal resize mid-stream must re-anchor the streaming block.
//
// Bug (T28): startStreamingBlock() records streamingStartLine at the start
// width. A width change mid-stream triggers a full rebuildHistory() that
// re-wraps every preceding message at the new width (changing how many lines
// they occupy), but historically left streamingStartLine pointing at the old
// buffer offset. The next updateStreamingBlock() then truncateToLine()d to
// that STALE index, chopping correctly-rendered lines and re-appending the
// streamed text at the wrong position, visibly corrupting the transcript for
// the rest of the turn.
//
// Fix: track _streamWidth; on a width change updateStreamingBlock() forces the
// pending rebuild, and rebuildHistory() re-anchors streamingStartLine to the
// freshly rebuilt buffer (the line where the streamed content begins).
//
// These tests assert the streaming block re-anchors to the correct
// content-start line so the tail of the buffer is EXACTLY the streamed content
// re-rendered at the new width (under its turn's spine), no stale offset, no
// leaked preceding lines.
// ---------------------------------------------------------------------------

// A long single-line message wraps to a DIFFERENT number of lines at width 80
// vs width 40, so a stale (width-80) anchor would point into the wrong region
// of the width-40 buffer, exactly the corruption this guards against.
const LONG_USER =
  'The quick brown fox jumps over the lazy dog and then keeps running clear ' +
  'across the entire wide open field far beyond the distant horizon line.';
const STREAM_A =
  'Here is the first streamed paragraph that the assistant is emitting token ' +
  'by token while the user happens to resize their terminal window.';
const STREAM_B =
  STREAM_A +
  ' And here is a second sentence appended after the resize, proving later ' +
  'deltas still land at the correct re-anchored offset.';

const WIDE = 80;
const NARROW = 40;

/**
 * The streamed text as the transcript draws it: at its turn's text column
 * (9). These transcripts carry no model and no live source, so the streaming
 * turn has nothing for a header to say and draws no spine; a live turn's
 * header says "working" and the spine's │ runs beside the text.
 */
function streamed(content: string, width: number): ReturnType<typeof renderStreamingContinuation> {
  return renderStreamingContinuation(content, width, { gutter: [], gutterWidth: 6 }, 'rounded');
}

function manager(getWidth: () => number): ConversationManager {
  const cm = new ConversationManager(getWidth, createTestConfigManager());
  cm.setUnicodeCapable(true);
  return cm;
}

/** Read the private streamingStartLine for assertions. */
function startLine(cm: ConversationManager): number {
  return (cm as unknown as { streamingStartLine: number }).streamingStartLine;
}

describe('ConversationManager: terminal resize mid-stream', () => {
  test('re-anchors streamingStartLine when width changes between deltas', () => {
    let width = WIDE;
    const cm = manager(() => width);

    cm.addUserMessage(LONG_USER);
    cm.startStreamingBlock();
    // First delta arrives at the wide width.
    cm.updateStreamingBlock(STREAM_A);
    cm.getDisplayBlocks(); // flush at wide width

    // The user resizes the terminal narrower mid-stream; the next delta arrives.
    width = NARROW;
    cm.updateStreamingBlock(STREAM_A);

    const buffer = cm.getDisplayBlocks();
    const anchor = startLine(cm);
    const expectedTail = streamed(STREAM_A, NARROW);

    // The streamed content occupies exactly the tail of the buffer, starting at
    // the re-anchored streamingStartLine. If the anchor were stale, this slice
    // would include leaked (re-wrapped) user-message lines and fail to match.
    expect(anchor).toBeGreaterThan(0);
    expect(anchor).toBe(buffer.length - expectedTail.length);
    expect(buffer.slice(anchor)).toEqual(expectedTail);
  });

  test('a render-triggered rebuild during stream re-anchors, and later deltas land correctly', () => {
    let width = WIDE;
    const cm = manager(() => width);

    cm.addUserMessage(LONG_USER);
    cm.startStreamingBlock();
    cm.updateStreamingBlock(STREAM_A);

    // Resize, then let the RENDER path (getDisplayBlocks -> flushHistory ->
    // rebuildHistory) be what detects the width change and re-anchors, before
    // any further delta arrives.
    width = NARROW;
    cm.getDisplayBlocks();

    const anchorAfterRebuild = startLine(cm);
    expect(anchorAfterRebuild).toBeGreaterThan(0);
    expect(anchorAfterRebuild).toBe(
      cm.getDisplayBlocks().length -
        streamed(STREAM_A, NARROW).length,
    );

    // A subsequent delta (more content) must land at the re-anchored offset.
    cm.updateStreamingBlock(STREAM_B);
    const buffer = cm.getDisplayBlocks();
    const anchor = startLine(cm);
    const expectedTail = streamed(STREAM_B, NARROW);

    expect(anchor).toBe(buffer.length - expectedTail.length);
    expect(buffer.slice(anchor)).toEqual(expectedTail);
  });

  test('resized-mid-stream buffer matches a stream rendered natively at the narrow width', () => {
    // Oracle: a transcript that started narrow and never resized is the ground
    // truth. A transcript that started wide and resized to narrow mid-stream
    // must converge to the identical buffer once re-anchoring is correct.
    let width = WIDE;
    const resized = manager(() => width);
    resized.addUserMessage(LONG_USER);
    resized.startStreamingBlock();
    resized.updateStreamingBlock(STREAM_A);
    resized.getDisplayBlocks();
    width = NARROW;
    resized.updateStreamingBlock(STREAM_A);

    const native = manager(() => NARROW);
    native.addUserMessage(LONG_USER);
    native.startStreamingBlock();
    native.updateStreamingBlock(STREAM_A);

    expect(startLine(resized)).toBe(startLine(native));
    expect(resized.getDisplayBlocks()).toEqual(native.getDisplayBlocks());
  });
});
