import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';

describe('SessionMemoryStore', () => {
  let store: SessionMemoryStore;

  beforeEach(() => {
    store = new SessionMemoryStore();
  });

  describe('add()', () => {
    it('returns incrementing IDs (mem-1, mem-2)', () => {
      const id1 = store.add('first note');
      const id2 = store.add('second note');
      expect(id1).toBe('mem-1');
      expect(id2).toBe('mem-2');
    });

    it('rejects empty string, returns empty string', () => {
      const id = store.add('');
      expect(id).toBe('');
      expect(store.list()).toHaveLength(0);
    });

    it('rejects whitespace-only string, returns empty string', () => {
      const id = store.add('   ');
      expect(id).toBe('');
      expect(store.list()).toHaveLength(0);
    });

    it('stores trimmed text', () => {
      store.add('  hello  ');
      expect(store.list()[0].text).toBe('hello');
    });
  });

  describe('remove()', () => {
    it('returns true for an existing memory', () => {
      const id = store.add('to remove');
      expect(store.remove(id)).toBe(true);
      expect(store.list()).toHaveLength(0);
    });

    it('returns false for a nonexistent ID', () => {
      expect(store.remove('mem-999')).toBe(false);
    });
  });

  describe('list()', () => {
    it('returns all memories in insertion order', () => {
      store.add('alpha');
      store.add('beta');
      store.add('gamma');
      const ids = store.list().map(m => m.id);
      expect(ids).toEqual(['mem-1', 'mem-2', 'mem-3']);
    });

    it('returns empty array when no memories', () => {
      expect(store.list()).toHaveLength(0);
    });
  });

  describe('format()', () => {
    it('returns null when empty', () => {
      expect(store.format()).toBeNull();
    });

    it('returns formatted section when populated', () => {
      store.add('remember this');
      const output = store.format();
      expect(output).not.toBeNull();
      expect(output).toContain('## Session Memories (pinned)');
      expect(output).toContain('[mem-1] remember this');
    });

    it('includes all memories in output', () => {
      store.add('note one');
      store.add('note two');
      const output = store.format()!;
      expect(output).toContain('[mem-1] note one');
      expect(output).toContain('[mem-2] note two');
    });
  });

  describe('estimateTokens()', () => {
    it('returns 0 when empty', () => {
      expect(store.estimateTokens()).toBe(0);
    });

    it('returns a reasonable estimate proportional to text length', () => {
      // 40 chars / 4 = 10 tokens
      store.add('a'.repeat(40));
      const tokens = store.estimateTokens();
      expect(tokens).toBeGreaterThan(0);
      // Should be roughly chars/4 (within 2x margin for reasonableness)
      expect(tokens).toBeLessThanOrEqual(40);
    });

    it('accumulates across multiple memories', () => {
      store.add('a'.repeat(40));  // 10 tokens
      store.add('b'.repeat(40));  // 10 tokens
      expect(store.estimateTokens()).toBe(20);
    });
  });

  describe('clear()', () => {
    it('removes all memories', () => {
      store.add('one');
      store.add('two');
      store.clear();
      expect(store.list()).toHaveLength(0);
    });

    it('preserves counter so IDs do not restart after clear()', () => {
      store.add('first');
      store.add('second');
      store.clear();
      const id = store.add('after clear');
      // Counter was at 2 before clear, next ID must be mem-3, not mem-1
      expect(id).toBe('mem-3');
    });

    it('format() returns null after clear', () => {
      store.add('something');
      store.clear();
      expect(store.format()).toBeNull();
    });
  });
});
