/**
 * Tests for the SDK SessionLineageTracker as consumed by the TUI.
 *
 * Run with: bun test src/test/core/session-lineage.test.ts
 *
 * Note: the tracker's `format()` helper was removed in goodvibes-sdk 0.34.1
 * (it duplicated the canonical buildSessionLineage). These tests verify the
 * data API the TUI actually consumes, getOriginalTask / getEntries /
 * getCompactionCount, rather than a rendered string.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core';

describe('SessionLineageTracker', () => {
  let tracker: SessionLineageTracker;

  beforeEach(() => {
    tracker = new SessionLineageTracker();
  });

  // ---------------------------------------------------------------------------
  // setOriginalTask / getOriginalTask
  // ---------------------------------------------------------------------------

  describe('setOriginalTask', () => {
    it('sets the task', () => {
      tracker.setOriginalTask('build the thing');
      expect(tracker.getOriginalTask()).toBe('build the thing');
    });

    it('silently ignores second call (overwrite guard; idempotent)', () => {
      tracker.setOriginalTask('first task');
      tracker.setOriginalTask('second task');
      expect(tracker.getOriginalTask()).toBe('first task');
    });

    it('returns null when never set', () => {
      expect(tracker.getOriginalTask()).toBeNull();
    });

    it('stays null after adding entries but no task', () => {
      tracker.addCompactionEntry('some compaction');
      expect(tracker.getOriginalTask()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // addCompactionEntry / getEntries
  // ---------------------------------------------------------------------------

  describe('addCompactionEntry', () => {
    it('appends entries with incrementing numbers', () => {
      tracker.setOriginalTask('some task');
      tracker.addCompactionEntry('first compaction');
      tracker.addCompactionEntry('second compaction');
      const entries = tracker.getEntries();
      expect(entries).toEqual(['- #1: first compaction', '- #2: second compaction']);
    });

    it('rejects empty summary', () => {
      tracker.addCompactionEntry('');
      expect(tracker.getCompactionCount()).toBe(0);
      expect(tracker.getEntries()).toEqual([]);
    });

    it('rejects whitespace-only summary', () => {
      tracker.addCompactionEntry('   ');
      expect(tracker.getCompactionCount()).toBe(0);
    });

    it('getEntries returns a copy (mutating it does not affect the tracker)', () => {
      tracker.addCompactionEntry('one');
      const snapshot = tracker.getEntries();
      snapshot.push('- #99: injected');
      expect(tracker.getCompactionCount()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getCompactionCount
  // ---------------------------------------------------------------------------

  describe('getCompactionCount', () => {
    it('returns 0 when no entries added', () => {
      expect(tracker.getCompactionCount()).toBe(0);
    });

    it('returns correct count after adding entries', () => {
      tracker.addCompactionEntry('one');
      tracker.addCompactionEntry('two');
      tracker.addCompactionEntry('three');
      expect(tracker.getCompactionCount()).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------

  describe('reset', () => {
    it('clears task and entries', () => {
      tracker.setOriginalTask('some task');
      tracker.addCompactionEntry('entry one');
      tracker.reset();
      expect(tracker.getOriginalTask()).toBeNull();
      expect(tracker.getCompactionCount()).toBe(0);
      expect(tracker.getEntries()).toEqual([]);
    });

    it('allows setOriginalTask to be called again after reset', () => {
      tracker.setOriginalTask('first task');
      tracker.reset();
      tracker.setOriginalTask('new task after reset');
      expect(tracker.getOriginalTask()).toBe('new task after reset');
    });
  });
});
