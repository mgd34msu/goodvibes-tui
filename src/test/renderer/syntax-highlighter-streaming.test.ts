// ---------------------------------------------------------------------------
// syntax-highlighter-streaming.test.ts
//
// Verifies the finalize-only tree-sitter scheduling gate using the real
// SyntaxHighlighter class (not an inlined reimplementation).
//
// 1. highlight(code, lang, isStreaming=true) never adds to the pending set.
// 2. highlight(code, lang, isStreaming=false) adds to pending exactly once.
// 3. Cache hits are returned regardless of isStreaming flag.
//
// Observable: SyntaxHighlighter.pending is private, accessed via type cast.
// The pending set is populated synchronously inside scheduleParse (before the
// async Promise microtask), so assertions are valid immediately after highlight().
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'bun:test';
import { SyntaxHighlighter } from '../../renderer/syntax-highlighter.ts';

// Type cast helper: access private fields for test observation only.
// scheduleParse() calls pending.add(key) synchronously before launching the
// async microtask, so pending reflects scheduling decisions immediately.
type HighlighterInternals = {
  pending: Set<string>;
  cache: Map<string, unknown[]>;
};
function internals(hl: SyntaxHighlighter): HighlighterInternals {
  return hl as unknown as HighlighterInternals;
}

describe('SyntaxHighlighter streaming gate', () => {
  it('isStreaming=true: pending set stays empty after 50 delta calls', () => {
    const hl = new SyntaxHighlighter();
    const code = 'const x = 1;';

    // Simulate ~50 delta calls (worst-case streaming scenario)
    for (let i = 1; i <= 50; i++) {
      const partial = code.slice(0, i);
      hl.highlight(partial, 'ts', true);
    }

    expect(internals(hl).pending.size).toBe(0);
  });

  it('isStreaming=false (finalized): key added to pending on first call', () => {
    const hl = new SyntaxHighlighter();
    const code = 'const x = 1;';

    // First call with isStreaming=false schedules a parse (key enters pending)
    hl.highlight(code, 'ts', false);
    expect(internals(hl).pending.size).toBe(1);

    // Subsequent calls with the same key while pending do not double-schedule
    hl.highlight(code, 'ts', false);
    hl.highlight(code, 'ts', false);
    expect(internals(hl).pending.size).toBe(1);
  });

  it('default isStreaming=false: backward-compatible — schedules parse on first call', () => {
    const hl = new SyntaxHighlighter();
    hl.highlight('let y = 2;', 'javascript');
    expect(internals(hl).pending.size).toBe(1);
  });

  it('cache hit returns result regardless of isStreaming flag', () => {
    const hl = new SyntaxHighlighter();
    const code = 'console.log(42);';

    // Pre-populate the cache as if a parse completed
    // Key format: langId:hash — we need the same key highlight() would compute.
    // Trigger a non-streaming call to add the key to pending, then manually
    // inject the result into cache and clear pending to simulate parse completion.
    hl.highlight(code, 'js', false);
    // Grab the key from pending (there should be exactly one)
    const { pending, cache } = internals(hl);
    expect(pending.size).toBe(1);
    const key = [...pending][0];
    const fakeResult = [[{ text: 'console', fg: '#00ffff' }]];
    cache.set(key, fakeResult);
    pending.clear(); // simulate parse completed

    // isStreaming=true: cache hit still returned
    expect(hl.highlight(code, 'js', true)).toBe(fakeResult);
    // isStreaming=false: cache hit still returned
    expect(hl.highlight(code, 'js', false)).toBe(fakeResult);
    // No new pending entries (cache hit path skips scheduling)
    expect(pending.size).toBe(0);
  });

  it('unsupported language returns null regardless of isStreaming', () => {
    const hl = new SyntaxHighlighter();
    expect(hl.highlight('x = 1', 'ruby', true)).toBeNull();
    expect(hl.highlight('x = 1', 'ruby', false)).toBeNull();
    // Unsupported language exits before scheduling — pending must stay empty
    expect(internals(hl).pending.size).toBe(0);
  });

  it('streaming=true then false on finalized block: only finalize call enters pending', () => {
    const hl = new SyntaxHighlighter();
    const finalCode = 'function foo() { return 42; }';

    // During streaming: 20 deltas, no scheduling
    for (let i = 1; i <= 20; i++) {
      hl.highlight(finalCode.slice(0, i), 'ts', true);
    }
    expect(internals(hl).pending.size).toBe(0);

    // On finalize: the final content key enters pending
    hl.highlight(finalCode, 'ts', false);
    expect(internals(hl).pending.size).toBe(1);
  });

  it('different content hashes produce separate pending entries', () => {
    const hl = new SyntaxHighlighter();

    // Finalize two different code blocks
    hl.highlight('const a = 1;', 'ts', false);
    hl.highlight('const b = 2;', 'ts', false);
    // Two distinct keys enter pending
    expect(internals(hl).pending.size).toBe(2);
  });
});
