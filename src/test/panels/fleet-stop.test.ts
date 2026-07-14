/**
 * d1/d2 — fleet-stop.ts: the 'stopping…' write-window overlay tracker and
 * the state-dependent pause<->resume toggle + tree hints, split out of
 * fleet-panel.ts. Pure/isolated, so unit-tested here directly.
 */
import { describe, expect, test } from 'bun:test';
import type { ProcessCapabilities, ProcessNode, ProcessState } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import {
  FleetStopTracker,
  STOP_SETTLE_MS,
  STOPPING_GLYPH,
  BLOCKED_GLYPH,
  fleetStateDisplay,
  toggleFleetPause,
  buildFleetTreeHints,
  type FleetPauseDeps,
} from '../../panels/fleet-stop.ts';

function caps(overrides: Partial<ProcessCapabilities> = {}): ProcessCapabilities {
  return { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false, ...overrides };
}

function makeNode(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'schedule',
    label: overrides.id,
    state: 'idle' as ProcessState,
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: caps(),
    ...overrides,
  } as ProcessNode;
}

function makeDeps(overrides: Partial<FleetPauseDeps> = {}): FleetPauseDeps & {
  calls: { interrupt: string[]; resume: string[]; errors: string[]; dirty: number };
} {
  const calls = { interrupt: [] as string[], resume: [] as string[], errors: [] as string[], dirty: 0 };
  const tracker = overrides.tracker ?? new FleetStopTracker();
  return {
    interrupt: (id) => { calls.interrupt.push(id); return true; },
    resume: (id) => { calls.resume.push(id); return true; },
    setError: (m) => { calls.errors.push(m); },
    markDirty: () => { calls.dirty++; },
    tracker,
    ...overrides,
    calls,
  } as FleetPauseDeps & { calls: typeof calls };
}

describe('FleetStopTracker (d1)', () => {
  test('mark → isStopping true within the settle window, false (pruned) after it', () => {
    const t = new FleetStopTracker();
    t.mark('a', 1_000);
    expect(t.isStopping('a', 1_000)).toBe(true);
    expect(t.isStopping('a', 1_000 + STOP_SETTLE_MS - 1)).toBe(true);
    // At/after the window the TRUE state is shown again — a stuck kill is never masked.
    expect(t.isStopping('a', 1_000 + STOP_SETTLE_MS)).toBe(false);
    // Pruned: a later query stays false without re-marking.
    expect(t.isStopping('a', 1_000 + 10)).toBe(false);
  });

  test('clear() drops the marker immediately (a resume is a start, not a stop)', () => {
    const t = new FleetStopTracker();
    t.mark('a', 1_000);
    t.clear('a');
    expect(t.isStopping('a', 1_000)).toBe(false);
  });

  test('an unmarked id is never stopping', () => {
    expect(new FleetStopTracker().isStopping('nope')).toBe(false);
  });
});

describe('fleetStateDisplay (d1)', () => {
  test('stopping overrides glyph/label/tone with the display-only stopping marker', () => {
    const d = fleetStateDisplay('executing-tool', true);
    expect(d.glyph).toBe(STOPPING_GLYPH);
    expect(d.label).toBe('stopping…');
    expect(d.tone).toBe('warn');
  });

  test('not stopping passes the true state through', () => {
    const d = fleetStateDisplay('killed', false);
    expect(d.label).toBe('killed');
    expect(d.glyph).not.toBe(STOPPING_GLYPH);
  });

  test('blocked (not stopping) shows the distinct ⚑ blocked-on-you badge', () => {
    const d = fleetStateDisplay('awaiting-approval', false, true);
    expect(d.glyph).toBe(BLOCKED_GLYPH);
    expect(d.label).toBe('blocked on you');
    expect(d.tone).toBe('warn');
  });

  test('an in-flight stop wins over blocked', () => {
    const d = fleetStateDisplay('awaiting-approval', true, true);
    expect(d.glyph).toBe(STOPPING_GLYPH);
    expect(d.label).toBe('stopping…');
  });
});

describe('toggleFleetPause (d2)', () => {
  test('paused + resumable → resume, clears any stop marker, marks dirty, consumed', () => {
    const deps = makeDeps();
    deps.tracker.mark('s1'); // a stale stop marker
    const node = makeNode({ id: 's1', kind: 'schedule', state: 'paused', capabilities: caps({ resumable: true }) });
    expect(toggleFleetPause(node, deps)).toBe(true);
    expect(deps.calls.resume).toEqual(['s1']);
    expect(deps.calls.interrupt).toEqual([]);
    expect(deps.tracker.isStopping('s1')).toBe(false); // cleared
    expect(deps.calls.dirty).toBe(1);
  });

  test('live + pausable → interrupt (the disable/pause path), marks a stop, consumed', () => {
    const deps = makeDeps();
    const node = makeNode({ id: 's1', kind: 'schedule', state: 'idle', capabilities: caps({ pausable: true }) });
    expect(toggleFleetPause(node, deps)).toBe(true);
    expect(deps.calls.interrupt).toEqual(['s1']);
    expect(deps.calls.resume).toEqual([]);
    expect(deps.tracker.isStopping('s1')).toBe(true); // 'stopping…' shown for the write window
    expect(deps.calls.dirty).toBe(1);
  });

  test('paused + NOT resumable → honest refusal, no resume, consumed', () => {
    const deps = makeDeps();
    const node = makeNode({ id: 't1', kind: 'trigger', state: 'paused', capabilities: caps({ resumable: false }) });
    expect(toggleFleetPause(node, deps)).toBe(true);
    expect(deps.calls.resume).toEqual([]);
    expect(deps.calls.errors).toEqual(['trigger cannot be resumed.']);
  });

  test('live + NOT pausable → honest refusal, no interrupt, consumed', () => {
    const deps = makeDeps();
    const node = makeNode({ id: 'a1', kind: 'agent', state: 'executing-tool', capabilities: caps({ pausable: false }) });
    expect(toggleFleetPause(node, deps)).toBe(true);
    expect(deps.calls.interrupt).toEqual([]);
    expect(deps.calls.errors).toEqual(['agent does not support pause.']);
  });

  test('terminal, non-paused node → falls through (not consumed), no side effects', () => {
    const deps = makeDeps();
    const node = makeNode({ id: 'a1', kind: 'agent', state: 'killed', capabilities: caps({ pausable: true }) });
    expect(toggleFleetPause(node, deps)).toBe(false);
    expect(deps.calls.interrupt).toEqual([]);
    expect(deps.calls.resume).toEqual([]);
    expect(deps.calls.dirty).toBe(0);
  });
});

describe('buildFleetTreeHints (d2)', () => {
  test('a paused resumable node shows "p resume", never "p pause"', () => {
    const node = makeNode({ id: 's1', kind: 'schedule', state: 'paused', capabilities: caps({ resumable: true }) });
    const hints = buildFleetTreeHints(node, false, false);
    expect(hints).toContainEqual({ keys: 'p', label: 'resume' });
    expect(hints).not.toContainEqual({ keys: 'p', label: 'pause' });
  });

  test('a live pausable node shows "p pause", never "p resume"', () => {
    const node = makeNode({ id: 's1', kind: 'schedule', state: 'idle', capabilities: caps({ pausable: true }) });
    const hints = buildFleetTreeHints(node, false, false);
    expect(hints).toContainEqual({ keys: 'p', label: 'pause' });
    expect(hints).not.toContainEqual({ keys: 'p', label: 'resume' });
  });

  test('a live capable agent shows i/K; a terminal node shows neither', () => {
    const live = makeNode({ id: 'a', kind: 'agent', state: 'executing-tool', capabilities: caps({ interruptible: true, killable: true }) });
    const liveHints = buildFleetTreeHints(live, false, false);
    expect(liveHints).toContainEqual({ keys: 'i', label: 'interrupt' });
    expect(liveHints).toContainEqual({ keys: 'K', label: 'kill' });

    const dead = makeNode({ id: 'a', kind: 'agent', state: 'done', capabilities: caps({ interruptible: true, killable: true }) });
    const deadHints = buildFleetTreeHints(dead, false, false);
    expect(deadHints).not.toContainEqual({ keys: 'i', label: 'interrupt' });
    expect(deadHints).not.toContainEqual({ keys: 'K', label: 'kill' });
  });

  test('a positive blocked count surfaces the b jump chip; zero hides it', () => {
    const node = makeNode({ id: 'a', kind: 'agent', state: 'executing-tool' });
    const withBlocked = buildFleetTreeHints(node, false, false, 'active', 3);
    expect(withBlocked).toContainEqual({ keys: 'b', label: 'blocked (3)' });
    const none = buildFleetTreeHints(node, false, false, 'active', 0);
    expect(none.some((h) => h.keys === 'b')).toBe(false);
  });

  test('follow + tabs flags surface their chips', () => {
    const hints = buildFleetTreeHints(undefined, true, true);
    expect(hints).toContainEqual({ keys: 'f', label: 'follow:on' });
    expect(hints).toContainEqual({ keys: '[ ]', label: 'tabs' });
  });

  test('Enter is context-sensitive: pick / resolve conflict / attach by the row', () => {
    const pickRow = makeNode({ id: 'workstream:ws1', kind: 'workstream', state: 'awaiting-approval', needsAttention: { reason: 'pick' } });
    expect(buildFleetTreeHints(pickRow, false, false)).toContainEqual({ keys: 'Enter', label: 'pick' });
    const conflictRow = makeNode({ id: 'work-item:it1', kind: 'work-item', state: 'stalled', needsAttention: { reason: 'conflict' } });
    expect(buildFleetTreeHints(conflictRow, false, false)).toContainEqual({ keys: 'Enter', label: 'resolve conflict' });
    const agentRow = makeNode({ id: 'a1', kind: 'agent', state: 'executing-tool' });
    expect(buildFleetTreeHints(agentRow, false, false)).toContainEqual({ keys: 'Enter', label: 'attach' });
  });

  test('a worktree-owning row surfaces the D discard chip; others do not', () => {
    const worktreeRow = makeNode({ id: 'work-item:it1', kind: 'work-item', state: 'done', raw: { item: { worktreePath: '/wt/it1' } } });
    expect(buildFleetTreeHints(worktreeRow, false, false)).toContainEqual({ keys: 'D', label: 'discard worktree' });
    const plainRow = makeNode({ id: 'a1', kind: 'agent', state: 'executing-tool' });
    expect(buildFleetTreeHints(plainRow, false, false).some((h) => h.keys === 'D')).toBe(false);
  });
});
