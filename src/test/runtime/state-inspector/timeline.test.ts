/**
 * Timeline buffer tests — correctness of the TimelineBuffer ring buffer
 * and time-travel step/seek controls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TimelineBuffer } from '../../../runtime/ui/state-inspector/timeline.ts';
import type { TimelineEvent } from '../../../runtime/ui/state-inspector/types.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(domain: string, ts: number, transitionId: number): Omit<TimelineEvent, 'seq'> {
  return {
    capturedAt: ts,
    domain,
    transitionId,
    snapshot: { value: transitionId },
  };
}

function fillBuffer(buf: TimelineBuffer, count: number, baseTs = 1000): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (let i = 1; i <= count; i++) {
    events.push(buf.append(makeEvent('session', baseTs + i, i)));
  }
  return events;
}

// ── Construction ─────────────────────────────────────────────────────────────

describe('TimelineBuffer — construction', () => {
  it('initialises with size 0 and live cursor', () => {
    const buf = new TimelineBuffer(10);
    expect(buf.size).toBe(0);
    expect(buf.isLive).toBe(true);
    expect(buf.totalAppended).toBe(0);
  });

  it('throws for maxSize < 2', () => {
    expect(() => new TimelineBuffer(1)).toThrow(RangeError);
    expect(() => new TimelineBuffer(0)).toThrow(RangeError);
  });

  it('exposes maxSize', () => {
    const buf = new TimelineBuffer(42);
    expect(buf.maxSize).toBe(42);
  });
});

// ── Append ────────────────────────────────────────────────────────────────────

describe('TimelineBuffer — append', () => {
  it('assigns monotonic seq numbers starting at 1', () => {
    const buf = new TimelineBuffer(10);
    const e1 = buf.append(makeEvent('a', 100, 1));
    const e2 = buf.append(makeEvent('a', 200, 2));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  it('increments size up to maxSize', () => {
    const buf = new TimelineBuffer(3);
    fillBuffer(buf, 3);
    expect(buf.size).toBe(3);
    expect(buf.totalAppended).toBe(3);
  });

  it('caps size at maxSize after overflow', () => {
    const buf = new TimelineBuffer(3);
    fillBuffer(buf, 10);
    expect(buf.size).toBe(3);
    expect(buf.totalAppended).toBe(10);
  });

  it('cursor stays live when appending in live mode', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    expect(buf.isLive).toBe(true);
    expect(buf.cursorState.index).toBe(3); // = size
  });

  it('cursor stays pinned when appending in time-travel mode', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.stepBack();
    const beforeIdx = buf.cursorState.index;
    buf.append(makeEvent('a', 9999, 99));
    expect(buf.cursorState.index).toBe(beforeIdx); // pinned
  });
});

// ── getAll / getAt ────────────────────────────────────────────────────────────

describe('TimelineBuffer — getAll / getAt', () => {
  it('returns events in chronological order (non-wrapped)', () => {
    const buf = new TimelineBuffer(5);
    const evts = fillBuffer(buf, 3);
    const all = buf.getAll();
    expect(all.length).toBe(3);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('returns events in chronological order after wrap', () => {
    const buf = new TimelineBuffer(3);
    fillBuffer(buf, 5); // wrap: retains events 3,4,5
    const all = buf.getAll();
    expect(all.length).toBe(3);
    // Oldest is the one with seq 3, newest seq 5
    expect(all[0].seq).toBe(3);
    expect(all[2].seq).toBe(5);
  });

  it('getAt returns the event at the logical index', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    expect(buf.getAt(0)!.seq).toBe(1);
    expect(buf.getAt(2)!.seq).toBe(3);
    expect(buf.getAt(3)).toBeUndefined();
  });

  it('getAt returns undefined for negative index', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 2);
    expect(buf.getAt(-1)).toBeUndefined();
  });

  it('getAll returns empty array when buffer is empty', () => {
    const buf = new TimelineBuffer(5);
    expect(buf.getAll()).toEqual([]);
  });
});

// ── Time-travel step controls ─────────────────────────────────────────────────

describe('TimelineBuffer — stepBack / stepForward', () => {
  it('stepBack moves cursor from live to last event', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    expect(buf.isLive).toBe(true);
    const moved = buf.stepBack();
    expect(moved).toBe(true);
    expect(buf.isLive).toBe(false);
    expect(buf.cursorState.index).toBe(2); // 0-based: last event is index 2
  });

  it('stepBack returns false when already at index 0', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.seekTo(0);
    expect(buf.stepBack()).toBe(false);
    expect(buf.cursorState.index).toBe(0);
  });

  it('stepForward moves cursor toward live', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.seekTo(0);
    const moved = buf.stepForward();
    expect(moved).toBe(true);
    expect(buf.cursorState.index).toBe(1);
  });

  it('stepForward returns false when already live', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    expect(buf.isLive).toBe(true);
    expect(buf.stepForward()).toBe(false);
  });

  it('stepForward from last event transitions to live', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.seekTo(2); // last event
    buf.stepForward();
    expect(buf.isLive).toBe(true);
  });

  it('full step-back traversal covers all events', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 4);
    const visited: number[] = [];
    while (buf.stepBack()) {
      visited.push(buf.cursorState.index);
    }
    expect(visited).toEqual([3, 2, 1, 0]);
  });
});

// ── seekTo / seekToTime ───────────────────────────────────────────────────────

describe('TimelineBuffer — seekTo / seekToTime', () => {
  it('seekTo clamps to valid range [0, size]', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.seekTo(-10);
    expect(buf.cursorState.index).toBe(0);
    buf.seekTo(9999);
    expect(buf.cursorState.index).toBe(3); // = size = live
    expect(buf.isLive).toBe(true);
  });

  it('seekTo(size) restores live position', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.seekTo(0);
    expect(buf.isLive).toBe(false);
    buf.seekTo(buf.size);
    expect(buf.isLive).toBe(true);
  });

  it('seekToTime seeks to the nearest event at or before timestamp', () => {
    const buf = new TimelineBuffer(10);
    buf.append(makeEvent('a', 1000, 1));
    buf.append(makeEvent('a', 2000, 2));
    buf.append(makeEvent('a', 3000, 3));
    buf.seekToTime(2500);
    // Event at 2000 is the newest <= 2500
    expect(buf.cursorState.index).toBe(1);
    expect(buf.getCurrentEvent()!.capturedAt).toBe(2000);
  });

  it('seekToTime with exact match finds that event', () => {
    const buf = new TimelineBuffer(10);
    buf.append(makeEvent('a', 1000, 1));
    buf.append(makeEvent('a', 2000, 2));
    buf.seekToTime(2000);
    expect(buf.getCurrentEvent()!.capturedAt).toBe(2000);
  });

  it('seekToTime before all events lands at index 0', () => {
    const buf = new TimelineBuffer(10);
    buf.append(makeEvent('a', 5000, 1));
    buf.append(makeEvent('a', 6000, 2));
    buf.seekToTime(100);
    expect(buf.cursorState.index).toBe(0);
  });

  it('seekToTime on empty buffer is a no-op', () => {
    const buf = new TimelineBuffer(10);
    buf.seekToTime(9999);
    expect(buf.size).toBe(0);
    expect(buf.isLive).toBe(true);
  });
});

// ── exitTimeTravel ────────────────────────────────────────────────────────────

describe('TimelineBuffer — exitTimeTravel', () => {
  it('returns cursor to live after seekTo', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 4);
    buf.seekTo(1);
    expect(buf.isLive).toBe(false);
    buf.exitTimeTravel();
    expect(buf.isLive).toBe(true);
  });
});

// ── getCurrentEvent ───────────────────────────────────────────────────────────

describe('TimelineBuffer — getCurrentEvent', () => {
  it('returns undefined when live', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    expect(buf.getCurrentEvent()).toBeUndefined();
  });

  it('returns the correct pinned event', () => {
    const buf = new TimelineBuffer(5);
    const evts = fillBuffer(buf, 3);
    buf.seekTo(1);
    const current = buf.getCurrentEvent();
    expect(current!.seq).toBe(evts[1].seq);
  });
});

// ── clear ────────────────────────────────────────────────────────────────────

describe('TimelineBuffer — clear', () => {
  it('resets all state', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 5);
    buf.seekTo(2);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.totalAppended).toBe(0);
    expect(buf.isLive).toBe(true);
    expect(buf.getAll()).toEqual([]);
  });

  it('new events after clear get seq starting at 1', () => {
    const buf = new TimelineBuffer(5);
    fillBuffer(buf, 3);
    buf.clear();
    const e = buf.append(makeEvent('a', 999, 99));
    expect(e.seq).toBe(1);
  });
});

// ── Ring-buffer correctness after wrap ───────────────────────────────────────

describe('TimelineBuffer — ring-buffer correctness', () => {
  it('retains only the most recent maxSize events', () => {
    const buf = new TimelineBuffer(4);
    for (let i = 1; i <= 10; i++) {
      buf.append(makeEvent('a', i * 100, i));
    }
    const all = buf.getAll();
    expect(all.length).toBe(4);
    expect(all[0].transitionId).toBe(7); // 10-4+1
    expect(all[3].transitionId).toBe(10);
  });

  it('cursorState.total reflects current size', () => {
    const buf = new TimelineBuffer(3);
    expect(buf.cursorState.total).toBe(0);
    buf.append(makeEvent('a', 1, 1));
    expect(buf.cursorState.total).toBe(1);
    fillBuffer(buf, 10);
    expect(buf.cursorState.total).toBe(3); // capped at maxSize
  });
});
