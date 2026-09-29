import { describe, expect, test } from 'bun:test';
import { MAIN, SessionFocus, STOP_CONFIRM_MS, type SessionFocusDeps, type SessionMark } from '../../core/session-focus.ts';

type Known = { name: string; mark: SessionMark; parent?: string | null };

function focusWith(agents: Record<string, Known>, processes: Record<string, Known> = {}, clock = { now: 1000 }): SessionFocus {
  const deps: SessionFocusDeps = {
    liveAgents: () => Object.entries(agents).filter(([, a]) => a.mark === 'run' || a.mark === 'wait').map(([id, a]) => ({ id, name: a.name, mark: a.mark })),
    liveProcesses: () => Object.entries(processes).filter(([, p]) => p.mark === 'run').map(([id, p]) => ({ id, name: p.name, mark: p.mark })),
    agent: (id) => agents[id] ? { name: agents[id]!.name, mark: agents[id]!.mark } : null,
    process: (id) => processes[id] ? { name: processes[id]!.name, mark: processes[id]!.mark } : null,
    parentAgent: (id) => agents[id]?.parent ?? null,
    mainBusy: () => false,
    now: () => clock.now,
  };
  return new SessionFocus(deps);
}

describe('session focus', () => {
  test('starts in main; opening an unknown agent or process is refused', () => {
    const f = focusWith({ eng: { name: 'engineer', mark: 'run' } });
    expect(f.current).toEqual(MAIN);
    expect(f.active).toBe(false);
    expect(f.open({ kind: 'agent', id: 'nope' })).toBe(false);
    expect(f.open({ kind: 'process', id: 'nope' })).toBe(false);
    expect(f.current).toEqual(MAIN);
  });

  test('Esc goes up one level: tester → engineer → main, and main has nothing to go back from', () => {
    const f = focusWith({ eng: { name: 'engineer', mark: 'run' }, tester: { name: 'tester', mark: 'run', parent: 'eng' } });
    f.open({ kind: 'agent', id: 'tester' });
    expect(f.breadcrumb().map((t) => f.nameOf(t))).toEqual(['main', 'engineer', 'tester']);
    expect(f.back()).toBe(true);
    expect(f.current).toEqual({ kind: 'agent', id: 'eng' });
    expect(f.back()).toBe(true);
    expect(f.current).toEqual(MAIN);
    expect(f.back()).toBe(false);
  });

  test('a process always goes back to main', () => {
    const f = focusWith({}, { p1: { name: 'bun run dev', mark: 'run' } });
    f.open({ kind: 'process', id: 'p1' });
    expect(f.parentOf(f.current)).toEqual(MAIN);
    f.back();
    expect(f.current).toEqual(MAIN);
  });

  test('chips list main, running agents and running processes; they show only with more than one session', () => {
    expect(focusWith({}).chipsVisible()).toBe(false);
    const f = focusWith({ a: { name: 'engineer', mark: 'run' }, b: { name: 'engineer', mark: 'run' }, done: { name: 'old', mark: 'ok' } }, { p: { name: 'bun run dev', mark: 'run' } });
    expect(f.sessions().map((s) => s.name)).toEqual(['main', 'engineer', 'engineer 2', 'bun run dev']);
    expect(f.chipsVisible()).toBe(true);
  });

  test('the session being shown stays listed after it finishes', () => {
    const f = focusWith({ done: { name: 'reviewer', mark: 'ok' } });
    f.open({ kind: 'agent', id: 'done' });
    expect(f.sessions().map((s) => s.name)).toEqual(['main', 'reviewer']);
  });

  test('Tab and Shift+Tab cycle the sessions and wrap', () => {
    const f = focusWith({ a: { name: 'engineer', mark: 'run' } }, { p: { name: 'dev', mark: 'run' } });
    f.cycle(1);
    expect(f.current).toEqual({ kind: 'agent', id: 'a' });
    f.cycle(1);
    expect(f.current).toEqual({ kind: 'process', id: 'p' });
    f.cycle(1);
    expect(f.current).toEqual(MAIN);
    f.cycle(-1);
    expect(f.current).toEqual({ kind: 'process', id: 'p' });
  });

  test('ctrl+x arms first and confirms on the second press within the window; a late press re-arms', () => {
    const clock = { now: 1000 };
    const f = focusWith({ a: { name: 'engineer', mark: 'run' } }, {}, clock);
    expect(f.pressStop()).toBe('none'); // main: nothing to stop this way
    f.open({ kind: 'agent', id: 'a' });
    expect(f.pressStop()).toBe('armed');
    expect(f.stopArmed()).toBe(true);
    expect(f.pressStop()).toBe('confirmed');
    expect(f.pressStop()).toBe('armed');
    clock.now += STOP_CONFIRM_MS + 1;
    expect(f.stopArmed()).toBe(false);
    expect(f.pressStop()).toBe('armed');
  });

  test('leaving a view drops an armed stop', () => {
    const f = focusWith({ a: { name: 'engineer', mark: 'run' } });
    f.open({ kind: 'agent', id: 'a' });
    f.pressStop();
    f.back();
    f.open({ kind: 'agent', id: 'a' });
    expect(f.stopArmed()).toBe(false);
    expect(f.pressStop()).toBe('armed');
  });
});
