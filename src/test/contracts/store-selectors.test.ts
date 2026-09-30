import { describe, test, expect } from 'bun:test';
import { createInitialRuntimeState, type RuntimeState } from '../../runtime/store/state.ts';
import {
  selectRunningTasks,
  selectRunningAgents,
  selectAnyOverlayVisible,
  selectStreamToolPreview,
  selectIsTurnActive,
  selectIsSessionReady,
  selectRunningTaskCountByKind,
} from '../../runtime/store/selectors/index.ts';

type TurnState = RuntimeState['conversation']['turnState'];

function withTurnState(turnState: TurnState): RuntimeState {
  const state = createInitialRuntimeState();
  return { ...state, conversation: { ...state.conversation, turnState } };
}

describe('store selectors', () => {
  const state = createInitialRuntimeState();

  test('the runtime state has no slot for the removed side-view layout', () => {
    expect(Object.keys(state)).not.toContain('panels');
  });

  test('a fresh state has nothing running, no overlay, no preview, and no active turn', () => {
    expect(selectRunningTasks(state)).toEqual([]);
    expect(selectRunningAgents(state)).toEqual([]);
    expect(selectAnyOverlayVisible(state)).toBe(false);
    expect(selectStreamToolPreview(state)).toBeUndefined();
    expect(selectIsTurnActive(state)).toBe(false);
    expect(selectRunningTaskCountByKind(state)).toEqual({});
  });

  test('selectIsTurnActive is true only between preflight and post-hooks', () => {
    const active: TurnState[] = ['preflight', 'streaming', 'tool_dispatch', 'post_hooks'];
    const inactive: TurnState[] = ['idle', 'completed', 'failed', 'cancelled'];
    for (const ts of active) expect(selectIsTurnActive(withTurnState(ts))).toBe(true);
    for (const ts of inactive) expect(selectIsTurnActive(withTurnState(ts))).toBe(false);
  });

  test('selectIsSessionReady needs an active session whose recovery is ready', () => {
    const ready = { ...state, session: { ...state.session, status: 'active', recoveryState: 'ready' } } as RuntimeState;
    const repairing = { ...state, session: { ...state.session, status: 'active', recoveryState: 'repairing' } } as RuntimeState;
    expect(selectIsSessionReady(ready)).toBe(true);
    expect(selectIsSessionReady(repairing)).toBe(false);
  });

  test('running agents follow activeAgentIds and skip ids with no record', () => {
    const a = { id: 'a' } as never;
    const b = { id: 'b' } as never;
    const s = {
      ...state,
      agents: { ...state.agents, agents: new Map([['a', a], ['b', b]]), activeAgentIds: ['b', 'ghost', 'a'] },
    } as RuntimeState;
    expect(selectRunningAgents(s).map((agent) => agent.id)).toEqual(['b', 'a']);
  });

  test('running tasks are ordered by start time and counted by kind', () => {
    const late = { id: 't1', kind: 'agent', startedAt: 200 } as never;
    const early = { id: 't2', kind: 'agent', startedAt: 100 } as never;
    const other = { id: 't3', kind: 'scheduler', startedAt: 150 } as never;
    const s = {
      ...state,
      tasks: { ...state.tasks, tasks: new Map([['t1', late], ['t2', early], ['t3', other]]), runningIds: ['t1', 't2', 't3', 'gone'] },
    } as RuntimeState;
    expect(selectRunningTasks(s).map((task) => task.id)).toEqual(['t2', 't3', 't1']);
    expect(selectRunningTaskCountByKind(s)).toEqual({ agent: 2, scheduler: 1 });
  });
});
