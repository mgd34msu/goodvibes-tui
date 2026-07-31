/**
 * Tests for the 'focus' token branch in feedInputTokens (src/input/handler-feed.ts).
 *
 * Covers the tokenizer note: focus-reporting sequences (\x1b[I / \x1b[O)
 * arrive through the same input pipeline as every other keystroke, tokenized
 * by the SDK's InputTokenizer, and must be consumed by the FIRST branch in
 * the feed loop — never reaching the composer's text/key routing, and never
 * mutating `prompt`/`cursorPos`.
 *
 * Uses a deliberately minimal InputFeedContext: only the fields
 * feedInputTokens() actually reads before/around a 'focus' token are
 * provided as real values; every other closure is a sentinel that throws if
 * called, so any future change that accidentally routes a focus token into
 * modal/panel/text/key handling fails this test loudly instead of silently
 * leaking an escape sequence into the prompt buffer.
 */
import { describe, test, expect } from 'bun:test';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import { feedInputTokens, type InputFeedContext } from '../../input/handler-feed.ts';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';

function unexpected(name: string) {
  return () => { throw new Error(`unexpected call: ${name} — a focus token must never reach this`); };
}

function buildMinimalContext(overrides: Partial<InputFeedContext> = {}): { context: InputFeedContext; renderCalls: number[] } {
  const renderCalls: number[] = [];
  let renderCount = 0;
  const context = {
    prompt: 'PRISTINE_COMPOSER_TEXT',
    cursorPos: 5,
    focusTracker: new FocusTracker(),
    keybindingsManager: { matches: unexpected('keybindingsManager.matches') },
    getHistory: () => ({ getLineCount: () => 0 }),
    getViewportHeight: () => 24,
    getScrollTop: () => 0,
    requestRender: () => { renderCount++; renderCalls.push(renderCount); },
    // Every other field is a throwing sentinel — a pure focus-token feed must
    // never touch any of these.
    handleCtrlC: unexpected('handleCtrlC'),
    selectionModal: {} as unknown as InputFeedContext['selectionModal'],
    selectionCallback: null,
    ...overrides,
  } as unknown as InputFeedContext;
  return { context, renderCalls };
}

describe('feedInputTokens — focus token consumption', () => {
  test('a focus-in token flips the tracker and does not throw', () => {
    const { context } = buildMinimalContext();
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I');
    expect(() => feedInputTokens(context, tokens)).not.toThrow();
    expect(context.focusTracker.isFocused()).toBe(true);
  });

  test('a focus-out token flips the tracker and does not throw', () => {
    const { context } = buildMinimalContext();
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[O');
    expect(() => feedInputTokens(context, tokens)).not.toThrow();
    expect(context.focusTracker.isFocused()).toBe(false);
  });

  test('focus tokens never mutate prompt/cursorPos (never leak into the composer)', () => {
    const { context } = buildMinimalContext();
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I\x1b[O\x1b[I');
    feedInputTokens(context, tokens);
    expect(context.prompt).toBe('PRISTINE_COMPOSER_TEXT');
    expect(context.cursorPos).toBe(5);
    expect(context.focusTracker.isFocused()).toBe(true); // last token was focus-in
  });

  test('a burst of alternating focus-in/focus-out tokens all get consumed in order', () => {
    const { context } = buildMinimalContext();
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I\x1b[O');
    expect(tokens).toHaveLength(2);
    feedInputTokens(context, tokens);
    // Final state reflects the LAST token processed (focus-out).
    expect(context.focusTracker.isFocused()).toBe(false);
  });

  test('still calls requestRender exactly once at the end of the feed (unchanged contract)', () => {
    const { context, renderCalls } = buildMinimalContext();
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I');
    feedInputTokens(context, tokens);
    expect(renderCalls).toEqual([1]);
  });
});
