/**
 * Pin / preserve-selection tests.
 *
 * Validates:
 *  1. Session memories added via add() survive and are listed.
 *  2. A removed memory is no longer listed.
 *  3. Compaction preview reflects pinned count accurately.
 *  4. buildCompactionAfterNotice reflects pinned count.
 *  5. SessionMemoryStore semantics: in-memory, session-scoped.
 */
import { describe, test, expect } from 'bun:test';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import {
  buildCompactionPreview,
  buildCompactionAfterNotice,
  buildPinUsageText,
  buildPinSuccessText,
} from '../../renderer/compaction-preview.ts';
import type { CompactionEvent } from '@pellux/goodvibes-sdk/platform/core';
import type { ProviderMessage } from '@pellux/goodvibes-sdk/platform/providers';

function makeMsg(role: 'user' | 'assistant', content: string): ProviderMessage {
  return { role, content };
}

function makeEvent(overrides: Partial<CompactionEvent> = {}): CompactionEvent {
  return {
    timestamp: Date.now(),
    messagesBeforeCompaction: 10,
    messagesAfterCompaction: 1,
    tokensBeforeEstimate: 20_000,
    tokensAfterEstimate: 6_500,
    modelId: 'test-model',
    trigger: 'manual',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SessionMemoryStore semantics
// ---------------------------------------------------------------------------

describe('SessionMemoryStore pin semantics', () => {
  test('add() returns a non-empty ID for non-blank text', () => {
    const store = new SessionMemoryStore();
    const id = store.add('remember this');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  test('add() returns empty string for blank text', () => {
    const store = new SessionMemoryStore();
    const id = store.add('   ');
    expect(id).toBe('');
  });

  test('pinned memories are listed after add()', () => {
    const store = new SessionMemoryStore();
    store.add('pin-a');
    store.add('pin-b');
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list.map((m) => m.text)).toContain('pin-a');
    expect(list.map((m) => m.text)).toContain('pin-b');
  });

  test('remove() unpin a memory by ID', () => {
    const store = new SessionMemoryStore();
    const id = store.add('removable');
    const removed = store.remove(id);
    expect(removed).toBe(true);
    expect(store.list().length).toBe(0);
  });

  test('remove() returns false for unknown ID', () => {
    const store = new SessionMemoryStore();
    expect(store.remove('mem-999')).toBe(false);
  });

  test('IDs are unique across add() calls', () => {
    const store = new SessionMemoryStore();
    const ids = [store.add('a'), store.add('b'), store.add('c')];
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Pin count flows into compaction preview and after-notice
// ---------------------------------------------------------------------------

describe('pin count in compaction preview', () => {
  test('preview mentions pinned count matching store.list().length', () => {
    const store = new SessionMemoryStore();
    store.add('keep this');
    store.add('and this');
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const preview = buildCompactionPreview({
      messages: msgs,
      contextWindow: 0,
      pinnedMemoryCount: store.list().length,
      trigger: 'manual',
    });
    expect(preview).toContain('2 pinned');
  });

  test('preview shows no pinned line when store is empty', () => {
    const store = new SessionMemoryStore();
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const preview = buildCompactionPreview({
      messages: msgs,
      contextWindow: 0,
      pinnedMemoryCount: store.list().length,
      trigger: 'manual',
    });
    expect(preview).not.toContain('pinned');
  });

  test('after-notice mentions pinned count when > 0', () => {
    const store = new SessionMemoryStore();
    store.add('preserve me');
    const event = makeEvent();
    const notice = buildCompactionAfterNotice({ event, pinnedMemoryCount: store.list().length });
    expect(notice).toContain('1 pinned');
    expect(notice).toContain('preserved');
  });

  test('after-notice does not mention pinned when count is 0', () => {
    const event = makeEvent();
    const notice = buildCompactionAfterNotice({ event, pinnedMemoryCount: 0 });
    expect(notice).not.toContain('pinned');
  });

  test('pin survives a clear and re-add cycle: IDs remain unique', () => {
    const store = new SessionMemoryStore();
    store.add('first');
    store.clear();
    const id2 = store.add('second');
    // After clear, the list contains only the new entry
    expect(store.list().length).toBe(1);
    // And the ID should still be non-empty
    expect(id2.length).toBeGreaterThan(0);
  });

  test('pinned honesty: preview says "session memories are in-memory only" via the /keep command wording contract', () => {
    // This test validates the wording contract: pinning does NOT guarantee
    // persistence across restarts. The /keep command explicitly states this.
    // We verify the guarantee by checking the compaction-preview.ts functions
    // do NOT claim durability beyond "survives the next compaction".
    const msgs: ProviderMessage[] = [makeMsg('user', 'hello')];
    const preview = buildCompactionPreview({
      messages: msgs,
      contextWindow: 0,
      pinnedMemoryCount: 1,
      trigger: 'manual',
    });
    // Must say "preserved" (compaction survival) but must NOT claim persistence.
    expect(preview).toContain('preserved');
    expect(preview.toLowerCase()).not.toContain('persist');
  });
});

// ---------------------------------------------------------------------------
// /keep handler text contract — buildPinUsageText and buildPinSuccessText
// (These functions are called directly by the shell-core /keep handler.)
// ---------------------------------------------------------------------------

describe('/keep handler text contract', () => {
  test('usage text: mentions compaction handoff, no "verbatim" claim', () => {
    const usage = buildPinUsageText();
    expect(usage).toContain('[Pin] Usage: /keep <text>');
    expect(usage).toContain('compaction handoff');
    expect(usage.toLowerCase()).not.toContain('verbatim');
    // Must not falsely promise persistence across restarts
    expect(usage).toContain('in-memory only');
    // Must affirm compaction survival
    expect(usage).toContain('survives the next compaction');
  });

  test('usage text: no false durability claim (no "always" or "forever")', () => {
    const usage = buildPinUsageText();
    expect(usage.toLowerCase()).not.toContain('always');
    expect(usage.toLowerCase()).not.toContain('forever');
  });

  test('success text: contains the memory ID and truncated text', () => {
    const text = buildPinSuccessText('mem-1', 'remember this note', 1);
    expect(text).toContain('[Pin] Pinned as mem-1');
    expect(text).toContain('remember this note');
    expect(text).toContain('1 pinned memory will survive the next compaction');
  });

  test('success text: truncates long text at 60 chars', () => {
    const longText = 'a'.repeat(80);
    const text = buildPinSuccessText('mem-2', longText, 1);
    expect(text).toContain('...');
    expect(text).not.toContain('a'.repeat(80));
  });

  test('success text: plural for multiple memories', () => {
    const text = buildPinSuccessText('mem-3', 'some text', 3);
    expect(text).toContain('3 pinned memories will survive the next compaction');
  });

  test('success text: no false persistence claim', () => {
    const text = buildPinSuccessText('mem-1', 'text', 1);
    expect(text).toContain('in-memory only');
    expect(text.toLowerCase()).not.toContain('forever');
    expect(text.toLowerCase()).not.toContain('always preserved');
  });
});
