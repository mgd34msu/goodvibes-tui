/**
 * Tests for session-lineage.ts
 *
 * Run with: bun test src/test/core/session-lineage.test.ts
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';

describe('SessionLineageTracker', () => {
  let tracker: SessionLineageTracker;

  beforeEach(() => {
    tracker = new SessionLineageTracker();
  });

  // ---------------------------------------------------------------------------
  // setOriginalTask
  // ---------------------------------------------------------------------------

  describe('setOriginalTask', () => {
    it('sets the task', () => {
      tracker.setOriginalTask('build the thing');
      const output = tracker.format();
      expect(output).toContain('build the thing');
    });

    it('silently ignores second call (overwrite guard)', () => {
      tracker.setOriginalTask('first task');
      tracker.setOriginalTask('second task');
      const output = tracker.format();
      expect(output).toContain('first task');
      expect(output).not.toContain('second task');
    });
  });

  // ---------------------------------------------------------------------------
  // addCompactionEntry
  // ---------------------------------------------------------------------------

  describe('addCompactionEntry', () => {
    it('appends entries with incrementing numbers', () => {
      tracker.setOriginalTask('some task');
      tracker.addCompactionEntry('first compaction');
      tracker.addCompactionEntry('second compaction');
      const output = tracker.format()!;
      expect(output).toContain('- #1: first compaction');
      expect(output).toContain('- #2: second compaction');
    });

    it('rejects empty summary', () => {
      tracker.addCompactionEntry('');
      expect(tracker.getCompactionCount()).toBe(0);
    });

    it('rejects whitespace-only summary', () => {
      tracker.addCompactionEntry('   ');
      expect(tracker.getCompactionCount()).toBe(0);
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
  // format
  // ---------------------------------------------------------------------------

  describe('format', () => {
    it('returns null when no task set', () => {
      expect(tracker.format()).toBeNull();
    });

    it('returns null when no task set even after adding entries', () => {
      tracker.addCompactionEntry('some compaction');
      expect(tracker.format()).toBeNull();
    });

    it('returns formatted section with task and entries', () => {
      tracker.setOriginalTask('implement the feature');
      tracker.addCompactionEntry('compacted conversation 1');
      tracker.addCompactionEntry('compacted conversation 2');
      const output = tracker.format()!;
      expect(output).toContain('## Session Lineage');
      expect(output).toContain('Original task: "implement the feature"');
      expect(output).toContain('Compactions: 2');
      expect(output).toContain('- #1: compacted conversation 1');
      expect(output).toContain('- #2: compacted conversation 2');
    });

    it('returns formatted section with task and no entries', () => {
      tracker.setOriginalTask('simple task');
      const output = tracker.format()!;
      expect(output).toContain('## Session Lineage');
      expect(output).toContain('Original task: "simple task"');
      expect(output).toContain('Compactions: 0');
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
      expect(tracker.format()).toBeNull();
      expect(tracker.getCompactionCount()).toBe(0);
    });

    it('allows setOriginalTask to be called again after reset', () => {
      tracker.setOriginalTask('first task');
      tracker.reset();
      tracker.setOriginalTask('new task after reset');
      const output = tracker.format()!;
      expect(output).toContain('new task after reset');
    });
  });
});
