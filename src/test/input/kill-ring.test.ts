import { describe, test, expect, beforeEach } from 'bun:test';
import { KillRing, KILL_RING_MAX, wordBoundaryBack, wordBoundaryForward } from '../../input/kill-ring.ts';

// ── KillRing ───────────────────────────────────────────────────────────────

describe('KillRing', () => {
  let ring: KillRing;
  beforeEach(() => { ring = new KillRing(); });

  test('starts empty', () => {
    expect(ring.hasEntries).toBe(false);
    expect(ring.getEntries().length).toBe(0);
  });

  test('yank on empty ring returns empty string', () => {
    expect(ring.yank()).toBe('');
  });

  test('yank-pop on empty ring returns empty string', () => {
    expect(ring.yankPop()).toBe('');
  });

  test('push adds entry and yank returns it', () => {
    ring.push('hello');
    expect(ring.hasEntries).toBe(true);
    expect(ring.yank()).toBe('hello');
  });

  test('push prepends; most-recent is yanked first', () => {
    ring.push('first');
    ring.push('second');
    expect(ring.yank()).toBe('second');
  });

  test('yank sets lastActionWasYank', () => {
    ring.push('a');
    expect(ring.lastActionWasYank).toBe(false);
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);
  });

  test('clearYankState resets lastActionWasYank', () => {
    ring.push('a');
    ring.yank();
    ring.clearYankState();
    expect(ring.lastActionWasYank).toBe(false);
  });

  test('yank-pop rotates to next entry', () => {
    ring.push('old');
    ring.push('new');
    ring.yank(); // positions at 'new'
    const popped = ring.yankPop();
    expect(popped).toBe('old');
  });

  test('yank-pop wraps around to head', () => {
    ring.push('a');
    ring.push('b');
    ring.yank();    // at 'b'
    ring.yankPop(); // at 'a'
    const wrapped = ring.yankPop(); // wraps back to 'b'
    expect(wrapped).toBe('b');
  });

  test('yank-pop sets lastActionWasYank', () => {
    ring.push('a');
    ring.push('b');
    ring.yank();
    ring.yankPop();
    expect(ring.lastActionWasYank).toBe(true);
  });

  test('bounded at KILL_RING_MAX entries', () => {
    for (let i = 0; i < KILL_RING_MAX + 5; i++) ring.push(`entry-${i}`);
    expect(ring.getEntries().length).toBe(KILL_RING_MAX);
  });

  test('oldest entry is evicted when capacity exceeded', () => {
    for (let i = 0; i < KILL_RING_MAX + 1; i++) ring.push(`e${i}`);
    const entries = ring.getEntries();
    // Most recent is e(MAX), oldest surviving is e1 — e0 was evicted.
    expect(entries[entries.length - 1]).toBe('e1');
  });

  test('push resets yank pointer to head', () => {
    ring.push('x');
    ring.push('y');
    ring.yank();    // at 'y'
    ring.yankPop(); // at 'x'
    ring.push('z'); // should reset pointer
    expect(ring.yank()).toBe('z');
  });
});
