import { describe, expect, test } from 'bun:test';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { buildTurnModel, MAX_NEST_DEPTH, transcriptUnits, turnSignature, type TurnModel, type TurnRow } from '../../core/work-tree-model.ts';
import type { AgentLaneInfo, WorkTreeSources } from '../../core/work-tree-sources.ts';
import { WorkTreeTimingStore } from '../../core/work-tree-sources.ts';

type Message = ConversationMessageSnapshot;
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({ id, name, arguments: args });
const asst = (content: string, calls?: ToolCall[], model = 'm1'): Message => ({ role: 'assistant', content, model, ...(calls ? { toolCalls: calls } : {}) });
const res = (callId: string, content = 'ok', toolName = 'exec'): Message => ({ role: 'tool', callId, toolName, content });
const spawn = (id: string, agentId: string): [ToolCall, Message] => [call(id, 'agent', { mode: 'spawn', task: `task ${agentId}` }), res(id, JSON.stringify({ agentId, status: 'spawned' }), 'agent')];

function model(messages: Message[], sources: WorkTreeSources = {}, collapse = new Map<string, boolean>(), streamingIndex = -1): TurnModel {
  const unit = transcriptUnits(messages).find((u) => u.kind === 'turn');
  if (!unit || unit.kind !== 'turn') throw new Error('no turn');
  return buildTurnModel({ messages, offset: 0, unit, sources: { now: () => 1000, ...sources }, collapse, streamingIndex });
}

function shape(rows: readonly TurnRow[]): string[] {
  return rows.map((r) => {
    switch (r.kind) {
      case 'bead': return `bead ${r.bead.lane}:${r.bead.name}:${r.bead.status}`;
      case 'spawn': return `spawn ${r.lane.parent}>${r.lane.id}`;
      case 'merge': return `merge ${r.lane.id}`;
      case 'folded': return `folded ${r.lane.id}`;
      case 'prose': return `prose ${r.role}`;
      default: return r.kind;
    }
  });
}

const agent = (id: string, messages: Message[], extra: Partial<AgentLaneInfo> = {}): AgentLaneInfo => ({ id, name: id, task: `task ${id}`, status: 'completed', toolCallCount: 1, messages, ...extra });

describe('transcript units', () => {
  test('a turn is every assistant and tool message between user messages; system messages at its edges stand alone', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' }, { role: 'system', content: 'before' },
      asst('look', [call('a', 'exec')]), { role: 'system', content: 'inside' }, res('a'), asst('done'),
      { role: 'system', content: 'after' }, { role: 'user', content: 'next' },
    ];
    expect(transcriptUnits(messages)).toEqual([
      { kind: 'message', index: 0 }, { kind: 'message', index: 1 },
      { kind: 'turn', start: 2, end: 5, headIndex: 2 },
      { kind: 'message', index: 6 }, { kind: 'message', index: 7 },
    ]);
  });
});

describe('turn rows', () => {
  test('one row per call, narration on the spine, the answer last', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('looking', [call('a', 'read'), call('b', 'exec')]), res('a', '{}', 'read'), res('b', '{"exit_code":0}'), asst('answer')]);
    expect(shape(m.rows)).toEqual(['head', 'prose assistant', 'bead spine:read:ok', 'bead spine:exec:ok', 'answer']);
    expect(m.toolCount).toBe(2);
  });

  test('a result that arrives out of order lands on its own call\'s bead', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [call('a', 'read'), call('b', 'exec')]), res('b', 'Error: boom'), res('a', '{}', 'read')]);
    expect(shape(m.rows)).toEqual(['head', 'bead spine:read:ok', 'bead spine:exec:err']);
  });

  test('an in-flight call spins while the turn works, and reads cancelled once it stopped', () => {
    const msgs: Message[] = [{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')])];
    expect(shape(model(msgs, { turnActive: () => true }).rows)).toEqual(['head', 'bead spine:exec:run']);
    expect(model(msgs, { turnActive: () => true }).live).toBe(true);
    expect(shape(model(msgs, { turnActive: () => false }).rows)).toEqual(['head', 'bead spine:exec:cancel']);
  });

  test('a call a permission prompt holds is waiting on the user', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')])], { turnActive: () => true, waitingCallIds: () => new Set(['a']) });
    expect(shape(m.rows)).toEqual(['head', 'bead spine:exec:wait']);
  });

  test('a streaming placeholder draws no prose of its own', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('partial text')], {}, new Map(), 1);
    expect(shape(m.rows)).toEqual(['head']);
  });

  test('a mid-turn model switch is said on the spine', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')], 'm1'), res('a'), asst('done', undefined, 'm2')]);
    expect(shape(m.rows)).toContain('prose system');
  });
});

describe('agent lanes', () => {
  const [spawnCall, spawnResult] = spawn('s', 'eng');
  const engMessages: Message[] = [asst('', [call('e1', 'read'), call('e2', 'exec')]), res('e1', '{}', 'read'), res('e2', '{"exit_code":0}')];

  test('a spawned agent branches into its own lane and merges back', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [spawnCall, call('m2', 'exec')]), spawnResult, res('m2'), asst('done')], { agent: (id) => (id === 'eng' ? agent('eng', engMessages) : null) });
    expect(shape(m.rows)).toEqual(['head', 'spawn spine>eng', 'bead eng:read:ok', 'bead eng:exec:ok', 'merge eng', 'bead spine:exec:ok', 'answer']);
    expect(m.agentCount).toBe(1);
  });

  test('with timings, lanes that ran at the same time interleave by start time', () => {
    const timings = new WorkTreeTimingStore();
    timings.callStarted('s', 100);
    timings.callStarted('e1', 200);
    timings.callStarted('m2', 300);
    timings.callStarted('e2', 400);
    const m = model(
      [{ role: 'user', content: 'q' }, asst('', [spawnCall, call('m2', 'exec')]), spawnResult, res('m2'), asst('done')],
      { callTiming: (id) => timings.callTiming(id), agent: (id) => (id === 'eng' ? agent('eng', engMessages, { startedAt: 150, completedAt: 500 }) : null) },
    );
    expect(shape(m.rows)).toEqual(['head', 'spawn spine>eng', 'bead eng:read:ok', 'bead spine:exec:ok', 'bead eng:exec:ok', 'merge eng', 'answer']);
  });

  test('a folded lane is one ◉ row carrying its outcome', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [spawnCall]), spawnResult], { agent: () => agent('eng', engMessages, { costUsd: 0.12 }) }, new Map([['lane_eng', true]]));
    expect(shape(m.rows)).toEqual(['head', 'folded eng']);
    const row = m.rows[1];
    expect(row?.kind === 'folded' ? [row.lane.outcome, row.lane.foldSummary] : null).toEqual(['ok', '1 tool · $0.12']);
  });

  test('a lane whose own call failed merges back amber; the failure does not climb past it', () => {
    const [innerCall, innerResult] = spawn('i', 'tester');
    const eng: Message[] = [asst('', [innerCall]), innerResult];
    const tester: Message[] = [asst('', [call('t1', 'exec')]), res('t1', 'Error: exit code 1')];
    const m = model([{ role: 'user', content: 'q' }, asst('', [spawnCall]), spawnResult], {
      agent: (id) => (id === 'eng' ? agent('eng', eng) : id === 'tester' ? agent('tester', tester) : null),
    });
    const merges = m.rows.filter((r): r is Extract<TurnRow, { kind: 'merge' }> => r.kind === 'merge').map((r) => [r.lane.id, r.lane.outcome]);
    expect(merges).toEqual([['tester', 'warn'], ['eng', 'ok']]);
  });

  test('status and wait calls naming an existing agent open no lane', () => {
    const m = model([{ role: 'user', content: 'q' }, asst('', [call('w', 'agent', { mode: 'wait', agentId: 'eng' })]), res('w', JSON.stringify({ agentId: 'eng', status: 'completed' }), 'agent')], { agent: () => agent('eng', engMessages) });
    expect(shape(m.rows)).toEqual(['head', 'bead spine:agent:ok']);
  });

  test('nesting deeper than the ceiling folds with a note, and a cycle stops', () => {
    // Each agent spawns the next: a0 → a1 → a2 → …
    const chain = (depth: number): AgentLaneInfo | null => {
      const [c, r] = spawn(`s${depth}`, `a${depth + 1}`);
      return agent(`a${depth}`, [asst('', [c]), r]);
    };
    const [c0, r0] = spawn('s-root', 'a0');
    const m = model([{ role: 'user', content: 'q' }, asst('', [c0]), r0], { agent: (id) => chain(Number(id.slice(1))) });
    const folded = m.rows.filter((r): r is Extract<TurnRow, { kind: 'folded' }> => r.kind === 'folded');
    expect(folded).toHaveLength(1);
    expect(folded[0]!.lane.truncated).toBe('depth');
    expect(m.rows.filter((r) => r.kind === 'spawn')).toHaveLength(MAX_NEST_DEPTH);

    const cyc = model([{ role: 'user', content: 'q' }, asst('', [c0]), r0], { agent: (id) => { const [c, r] = spawn('loop', 'a0'); return agent(id, [asst('', [c]), r]); } });
    const cycFolded = cyc.rows.filter((r): r is Extract<TurnRow, { kind: 'folded' }> => r.kind === 'folded');
    expect(cycFolded[0]?.lane.truncated).toBe('cycle');
  });

  test('while a lane still runs, the answer lands after the spine\'s last row and the lane keeps going under it', () => {
    const running: Message[] = [asst('', [call('r1', 'exec')])];
    const m = model([{ role: 'user', content: 'q' }, asst('', [spawnCall, call('m2', 'exec')]), spawnResult, res('m2'), asst('done')], {
      agent: () => agent('eng', running, { status: 'running', startedAt: 100 }),
      callTiming: (id) => ({ s: { startedAt: 100 }, m2: { startedAt: 200, durationMs: 50 }, r1: { startedAt: 300 } } as Record<string, { startedAt: number; durationMs?: number }>)[id],
      turnActive: () => false,
    });
    expect(shape(m.rows)).toEqual(['head', 'spawn spine>eng', 'bead spine:exec:ok', 'answer', 'bead eng:exec:run']);
    expect(m.live).toBe(true);
  });
});

describe('turn header and folding', () => {
  test('the header says model, tools, agents and time', () => {
    const timings = new WorkTreeTimingStore();
    timings.turnStarted(0, 0);
    timings.turnEnded(1900);
    const m = model([{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')]), res('a'), asst('done')], { turnTiming: (i) => timings.turnTiming(i) });
    expect(m.headerText).toBe('m1 · 1 tool · 1.9s');
  });

  test('a finished turn folds; a working one stays open', () => {
    const msgs: Message[] = [{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')]), res('a'), asst('done')];
    expect(model(msgs, {}, new Map([['turn_1', true]])).folded).toBe(true);
    expect(model(msgs, { turnActive: () => true }, new Map([['turn_1', true]])).folded).toBe(false);
  });

  test('opening a bead changes the turn signature, an unrelated key does not', () => {
    const msgs: Message[] = [{ role: 'user', content: 'q' }, asst('', [call('a', 'exec')]), res('a', '{"exit_code":0,"stdout":"x"}')];
    const closed = turnSignature(model(msgs));
    expect(turnSignature(model(msgs, {}, new Map([['code_9_0', true]])))).toEqual(closed);
    expect(turnSignature(model(msgs, {}, new Map([['bead_c:1:0', false]])))).not.toEqual(closed);
  });
});
