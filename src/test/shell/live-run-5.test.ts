/**
 * Defects from the fifth live run (a real WRFC chain and a real background
 * process), each pinned against the code path that drew it.
 *
 *  1. The chain owner's view (af0a3b51, template "engineer") said "No
 *     transcript yet" although its phase agents had run: an owner takes no
 *     turns, its work is its chain.
 *  2. A process ended by its timeout reads "timed out (signal …)", not
 *     "done …", and was counted as running after its pid was gone.
 *  3. The view's bar ran from under the chips to the composer with no blank
 *     row at either end.
 *  5. The process view's input area carried the status line's key hints.
 *  7. A long background summary pushed the cost and the context bar off the
 *     status line.
 *  9. [WRFC] and [Agents] notices were drawn inside the turn's lane.
 */
import { describe, expect, test } from 'bun:test';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { AgentManager, ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProcessNode, SteerResult } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { AgentLaneInfo, WorkTreeSources } from '../../core/work-tree-sources.ts';
import { SessionViews } from '../../shell/session-views.ts';
import { renderStatusLine } from '../../renderer/status-line.ts';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { lineToString } from '../setup.ts';

type Message = ConversationMessageSnapshot;
type AgentRecord = NonNullable<ReturnType<AgentManager['getStatus']>>;
type ProcessRecord = NonNullable<ReturnType<ProcessManager['getStatus']>>;

const NOW = 1_800_000_000_000;

function scene(opts: { processStatus?: string; processDone?: boolean } = {}) {
  const records = new Map<string, AgentRecord>();
  const add = (r: Partial<AgentRecord> & Pick<AgentRecord, 'id' | 'template' | 'task' | 'status' | 'startedAt'>): void => {
    records.set(r.id, ({ tools: [], toolCallCount: 0, ...r }) as AgentRecord);
  };
  const task = 'Spawn exactly one background agent whose task is: read src/net/retry.ts';
  add({ id: 'af0a3b51', template: 'engineer', task, status: 'running', startedAt: NOW - 43_000, wrfcRole: 'owner', wrfcId: 'wrfc-3c7f48cb' });
  add({ id: 'ca572da6', template: 'engineer', task, status: 'completed', startedAt: NOW - 42_000, completedAt: NOW - 9_000, toolCallCount: 1, wrfcRole: 'engineer' });
  add({ id: 'df40e5d8', template: 'reviewer', task: 'WRFC Review Request', status: 'running', startedAt: NOW - 8_000, wrfcRole: 'reviewer' });
  const transcripts: Record<string, Message[]> = {
    ca572da6: [
      { role: 'user', content: task },
      { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read', arguments: { files: [{ path: 'src/net/retry.ts' }] } }] },
      { role: 'tool', callId: 'r1', toolName: 'read', content: JSON.stringify({ success: true, summary: { files_read: 1, total_lines: 20 } }) },
      { role: 'assistant', content: 'I read both files and changed nothing.' },
    ],
    df40e5d8: [{ role: 'user', content: 'WRFC Review Request' }],
  };
  const lane = (id: string): AgentLaneInfo | null => {
    const r = records.get(id);
    if (!r) return null;
    const base = { id, name: r.template, task: r.task, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, toolCallCount: r.toolCallCount };
    if (id === 'af0a3b51') {
      return {
        ...base, messages: [], wrfcPhases: [
          { agentId: 'ca572da6', role: 'engineer', task, status: 'completed', startedAt: NOW - 42_000, completedAt: NOW - 9_000 },
          { agentId: 'df40e5d8', role: 'reviewer', task: 'WRFC Review Request', status: 'running', startedAt: NOW - 8_000 },
        ],
      };
    }
    return { ...base, messages: transcripts[id] ?? [] };
  };
  const sources: WorkTreeSources = { agent: lane, now: () => NOW };
  const proc: ProcessRecord = { id: 'bg-1', pid: 1776319, cmd: 'for i in 1 2 3; do echo tick $i; sleep 5; done', startTime: NOW - 61_000, stdout: ['tick 1\n'], stderr: [], exitCode: null, done: opts.processDone ?? false, killDeadline: null };
  const processManager = {
    list: () => [{ id: proc.id, pid: proc.pid, cmd: proc.cmd, status: opts.processStatus ?? (proc.done ? 'done (exit 0)' : 'running'), done: proc.done }],
    getStatus: () => proc,
    stop: () => false,
  } as unknown as Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;
  let renders = 0;
  const views = new SessionViews({
    conversation: { laneColorOf: () => 1, getWorkTreeSources: () => sources, getTreeGlyphSet: () => 'rounded' },
    agentManager: {
      list: () => [...records.values()],
      getStatus: (id: string) => records.get(id) ?? null,
      getConversationSnapshot: (id: string) => transcripts[id] ?? [],
    } as unknown as Pick<AgentManager, 'list' | 'getStatus' | 'getConversationSnapshot'>,
    processManager,
    fleetNodes: () => [] as unknown as ProcessNode[],
    steer: () => ({ queued: true }) as SteerResult,
    killAgent: () => [],
    mainBusy: () => false,
    mainModel: () => 'route-llm',
    promptText: () => '',
    requestRender: () => { renders++; },
    now: () => NOW,
    pollMs: 0,
  });
  return { views, proc, renders: () => renders };
}

const text = (lines: readonly import('@pellux/goodvibes-sdk/platform/types').Line[]): string[] => lines.map((l) => lineToString(l).replace(/\s+$/, ''));

describe('live run 5: a WRFC owner view shows its chain', () => {
  test('the owner is named "WRFC chain" on its chip, not by its template', () => {
    const { views } = scene();
    const chips = lineToString(views.chips(120)!);
    expect(chips).toContain('WRFC chain');
    expect(chips).not.toContain('engineer');
  });

  test("the owner's view draws each phase agent's own transcript as a lane, not \"No transcript yet\"", () => {
    const { views } = scene();
    views.open({ kind: 'agent', id: 'af0a3b51' });
    const body = text(views.frame(120, '2.0.21')!.body(30)).join('\n');
    expect(body).not.toContain('No transcript yet');
    expect(body).toContain('◆ WRFC chain');
    expect(body).toContain('WRFC chain · 2 phases');
    // The engineer phase's own read call, from its own transcript.
    expect(body).toMatch(/read src\/net\/retry\.ts/);
    expect(body).toContain('reviewer');
  });
});

describe('live run 5: a process that ended by its timeout is not running', () => {
  test('it leaves the chips, and its ending repaints the screen once', () => {
    const s = scene({ processDone: true, processStatus: 'timed out (signal SIGTERM)' });
    expect(lineToString(s.views.chips(120)!)).not.toContain('tick');
    expect(s.views.noteEnded()).toBe(true);
    expect(s.views.noteEnded()).toBe(false);
  });

  test('while it runs it is a ▶ chip', () => {
    const s = scene();
    expect(lineToString(s.views.chips(120)!)).toContain('▶');
    expect(s.views.noteEnded()).toBe(false);
  });
});

describe('live run 5: the view bar and its blank rows', () => {
  test('a blank row without the bar under the chips and above the composer; the bar on every row between', () => {
    const { views } = scene();
    views.open({ kind: 'agent', id: 'ca572da6' });
    const body = views.frame(120, '2.0.21')!.body(20);
    expect(body).toHaveLength(20);
    expect(lineToString(body[0]!).trim()).toBe('');
    expect(lineToString(body[19]!).trim()).toBe('');
    for (let r = 1; r < 19; r++) expect(body[r]![0]!.char).toBe('┃');
    // The head row sits on the bar's first row, as in the concept.
    expect(lineToString(body[1]!)).toContain('◆ engineer');
  });

  test('the process view gets the same blank rows', () => {
    const { views } = scene();
    views.open({ kind: 'process', id: 'bg-1' });
    const body = views.frame(120, '2.0.21')!.body(12);
    expect(lineToString(body[0]!).trim()).toBe('');
    expect(lineToString(body[11]!).trim()).toBe('');
    for (let r = 1; r < 11; r++) expect(body[r]![0]!.char).toBe('┃');
  });
});

describe('live run 5: the process input area holds only what it is', () => {
  test('the placeholder says there is no input here and carries no key hints', () => {
    const { views } = scene();
    views.open({ kind: 'process', id: 'bg-1' });
    const footer = views.frame(120, '2.0.21')!.footer;
    expect(footer.disabledReason).toBe("No input here: GoodVibes cannot write to this process's stdin");
    expect(footer.keys.map(([k]) => k)).toEqual(expect.arrayContaining(['/', 'y']));
  });
});

describe('live run 5: busy text shares the status line with the cost and the context bar', () => {
  const summary = { agents: 2, processes: 0, focused: false, progress: 'WRFC owner supervising child agents (reviewing)' };
  const context = { usedTokens: 31_100, windowTokens: 200_000, compactFraction: 0.8 };
  const chips = [{ text: '! auto-approve', fg: '#ff0000', keep: true }];
  for (const width of [80, 90, 100, 120, 160]) {
    test(`at ${width} columns the context bar stays and the summary is what gets cut`, () => {
      const line = lineToString(renderStatusLine({ width, chips, directory: '~/Projects/demo-proj', branch: 'main', background: summary, cost: '$0.12', context }));
      expect(line).toMatch(/[█░│]{6,} 16%/);
      expect(line).toContain('menu');
      expect(line).toContain('◐ 2 agents');
      if (width >= 120) {
        expect(line).toContain('$0.12');
        expect(line).toContain('31.1k / 200.0k');
      }
    });
  }

  test('a running turn keeps its esc key and the bar at 80 columns', () => {
    const busy = { spinner: '◐', frame: 0, phrase: 'Recalibrating the vibe matrix while the reviewer finishes its pass', elapsedMs: 12_000 };
    const line = lineToString(renderStatusLine({ width: 80, chips, busy, cost: '$0.12', context }));
    expect(line).toMatch(/[█░│]{6,} 16%/);
    expect(line).toContain('esc');
  });
});

describe('live run 5: notices are drawn after the turn, outside its lanes', () => {
  test('a [WRFC] notice that arrived mid-turn sits at the text column with no lane gutter, after the answer', () => {
    const messages: Message[] = [
      { role: 'user', content: 'spawn a reviewer' },
      { role: 'assistant', content: '', model: 'route-llm', toolCalls: [{ id: 'c1', name: 'agent', arguments: { mode: 'spawn', task: 'review' } }] },
      { role: 'system', content: '[WRFC] Chain wrfc-3c7f48cb started: review' },
      { role: 'tool', callId: 'c1', toolName: 'agent', content: JSON.stringify({ agentId: 'x', status: 'spawned' }) },
      { role: 'assistant', content: 'Started.', model: 'route-llm' },
    ];
    const lines: import('@pellux/goodvibes-sdk/platform/types').Line[] = [];
    const ctx: ConversationRenderContext = {
      history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
      blockRegistry: [], collapseState: new Map(), errorLineRegistry: [], messageKindRegistry: new Map(), configManager: null, splashOptions: {},
      workTreeSources: {}, treeGlyphSet: 'rounded', focusId: null, frame: 0,
    };
    appendConversationMessages(ctx, messages, 100, []);
    const rows = text(lines);
    const notice = rows.findIndex((r) => r.includes('[WRFC] Chain'));
    const answer = rows.findIndex((r) => r.includes('Started.'));
    expect(notice).toBeGreaterThan(answer);
    // Drawn like a notice between turns: its bar at column 3, nothing in the lane gutter.
    expect(rows[notice]!.indexOf('▌')).toBe(3);
    expect(rows[notice]!.slice(0, 3).trim()).toBe('');
  });
});

describe('live run 5: the context figure a resumed session starts from', () => {
  test('a follow-up acknowledgement (no tool definitions sent) never becomes the context size', async () => {
    const { sumConversationUsage } = await import('../../core/conversation-usage.ts');
    // The live run: the spawn turn's request, then three acknowledgements.
    const messages: Message[] = [
      { role: 'user', content: 'spawn' },
      { role: 'assistant', content: '', usage: { inputTokens: 13292, outputTokens: 139 } },
      { role: 'assistant', content: 'Started.', usage: { inputTokens: 1710, outputTokens: 29 }, followUp: true },
      { role: 'assistant', content: 'Reviewer done.', usage: { inputTokens: 1761, outputTokens: 16 }, followUp: true },
      { role: 'assistant', content: 'Review done.', usage: { inputTokens: 1796, outputTokens: 24 }, followUp: true },
    ];
    expect(sumConversationUsage(messages).lastInputTokens).toBe(13292);
  });
});
