/**
 * session-view-scenes.ts, the concept page's agent-focus and process-focus
 * scenes as live-looking fakes.
 *
 * An engineer agent (running, on its own model) that spawned a tester, and a
 * background dev server with a few minutes of output, all on a fixed clock.
 * SessionViews (shell/session-views.ts) is built over fake agent and process
 * managers that record every stop, kill and steer, so tests can prove what a
 * key did and did not do, and golden frames render the real view path.
 */

import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import type { AgentManager, ProcessManager } from '@pellux/goodvibes-sdk/platform/tools';
import type { ProcessNode, SteerResult } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { AgentLaneInfo, WorkTreeSources } from '../../core/work-tree-sources.ts';
import { SessionViews } from '../../shell/session-views.ts';
import { buildShellFooter } from '../../renderer/shell-surface.ts';
import { renderHeaderLine } from '../../renderer/header-line.ts';

type Message = ConversationMessageSnapshot;
type AgentRecord = NonNullable<ReturnType<AgentManager['getStatus']>>;
type ProcessRecord = NonNullable<ReturnType<ProcessManager['getStatus']>>;

/** The fixed clock every scene renders at. */
export const VIEW_NOW = 1_800_000_000_000;
export const FIXTURE_VERSION = '2.0.21';

const user = (content: string): Message => ({ role: 'user', content });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const assistant = (content: string, toolCalls?: ToolCall[]): Message => ({ role: 'assistant', content, model: 'claude-sonnet-5-5', provider: 'anthropic', ...(toolCalls ? { toolCalls } : {}) });
const result = (callId: string, toolName: string, content: string): Message => ({ role: 'tool', callId, toolName, content });

const ENG_START = VIEW_NOW - 134_000;
const TESTER_START = VIEW_NOW - 60_000;

function engineerMessages(): Message[] {
  return [
    user('add a maxDelayMs cap to withRetry'),
    assistant('', [
      call('e-read', 'read', { files: [{ path: 'src/net/retry.ts' }] }),
      call('e-edit', 'edit', { edits: [{ path: 'src/net/retry.ts', find: '      await sleep(backoff);', replace: '      await sleep(Math.min(backoff, opts.maxDelayMs));' }] }),
      call('e-spawn', 'agent', { mode: 'spawn', template: 'tester', task: 'cover the cap with tests' }),
    ]),
    result('e-read', 'read', JSON.stringify({ success: true, summary: { files_read: 1, total_lines: 20 }, files: [{ path: 'src/net/retry.ts', lineCount: 20 }] })),
    result('e-edit', 'edit', JSON.stringify({ applied: 1, failed: 0, dry_run: false })),
    result('e-spawn', 'agent', JSON.stringify({ agentId: 'tester', status: 'spawned', template: 'tester', task: 'cover the cap with tests' })),
    user('also cap the jitter, not only the base delay'),
    assistant('Good catch: the jitter is added after the cap, so it can overshoot. Clamping after the jitter.', [
      call('e-fix', 'edit', { edits: [{ path: 'src/net/retry.ts', find: 'Math.min(backoff, opts.maxDelayMs)', replace: 'Math.min(backoff + jitter, opts.maxDelayMs)' }] }),
    ]),
  ];
}

function testerMessages(): Message[] {
  return [
    user('cover the cap with tests'),
    assistant('', [call('t-exec', 'exec', { command: 'bun test test/retry.test.ts' })]),
  ];
}

const TIMINGS: Record<string, [number, number | undefined]> = {
  'e-read': [ENG_START + 2000, 100],
  'e-edit': [ENG_START + 5000, 200],
  'e-spawn': [ENG_START + 70_000, 50],
  't-exec': [VIEW_NOW - 3000, undefined],
  'e-fix': [VIEW_NOW - 1000, undefined],
};

/** A background dev server's output, arriving over twelve minutes. */
const DEV_OUTPUT: ReadonlyArray<readonly [number, 'stdout' | 'stderr', string]> = [
  [-724_000, 'stdout', '  VITE v6.2.0  ready in 412 ms\n'],
  [-724_000, 'stdout', '  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose\n'],
  [-268_000, 'stdout', 'hmr update /src/net/retry.ts\nhmr update /src/api/client.ts\n'],
  [-253_000, 'stderr', "error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.\n  at src/api/client.ts:31:18\n"],
  [-224_000, 'stdout', 'hmr update /src/api/client.ts\npage reload src/api/client.ts\n'],
  [-0, 'stdout', 'GET /api/health 200 in 3ms\n'],
];

export interface ViewSceneLog {
  readonly killed: string[];
  readonly stopped: string[];
  readonly steers: Array<{ readonly id: string; readonly text: string }>;
  readonly copied: string[];
}

export interface ViewScene {
  readonly views: SessionViews;
  readonly log: ViewSceneLog;
  /** Move the fake clock. */
  setNow(now: number): void;
  /** Set the composer text the views read. */
  setPrompt(text: string): void;
  /** Mark an agent finished (the chips drop it unless it is being shown). */
  finishAgent(id: string): void;
}

export function makeViewScene(options: { readonly withProcess?: boolean; readonly withTester?: boolean } = {}): ViewScene {
  let now = VIEW_NOW;
  let prompt = '';
  const log: ViewSceneLog = { killed: [], stopped: [], steers: [], copied: [] };
  const withTester = options.withTester ?? true;
  const records = new Map<string, AgentRecord>();
  const record = (r: Partial<AgentRecord> & Pick<AgentRecord, 'id' | 'template' | 'task' | 'status' | 'startedAt'>): AgentRecord =>
    ({ tools: [], toolCallCount: 0, ...r }) as AgentRecord;
  records.set('eng', record({ id: 'eng', template: 'engineer', task: 'add a maxDelayMs cap', status: 'running', startedAt: ENG_START, model: 'claude-sonnet-5-5', toolCallCount: 4 }));
  if (withTester) records.set('tester', record({ id: 'tester', template: 'tester', task: 'cover the cap with tests', status: 'running', startedAt: TESTER_START, toolCallCount: 1 }));
  const transcripts: Record<string, Message[]> = { eng: engineerMessages(), tester: testerMessages() };

  const agentManager = {
    list: () => [...records.values()],
    getStatus: (id: string) => records.get(id) ?? null,
    getConversationSnapshot: (id: string) => transcripts[id] ?? [],
  } as unknown as Pick<AgentManager, 'list' | 'getStatus' | 'getConversationSnapshot'>;

  const proc: ProcessRecord = { id: 'bg-1', pid: 48213, cmd: 'bun run dev', startTime: VIEW_NOW - 724_000, stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null };
  const processes = new Map<string, ProcessRecord>();
  if (options.withProcess ?? true) processes.set(proc.id, proc);
  const processManager = {
    list: () => [...processes.values()].map((p) => ({ id: p.id, pid: p.pid, cmd: p.cmd, status: p.done ? `done (exit ${p.exitCode})` : 'running' })),
    getStatus: (id: string) => processes.get(id),
    stop: (id: string) => { log.stopped.push(id); const p = processes.get(id); if (p) { p.done = true; p.exitCode = 143; } return p !== undefined; },
  } as unknown as Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;

  const laneInfo = (id: string): AgentLaneInfo | null => {
    const r = records.get(id);
    if (!r) return null;
    return { id, name: r.template, task: r.task, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, toolCallCount: r.toolCallCount, messages: transcripts[id] ?? [] };
  };
  const sources: WorkTreeSources = {
    callTiming: (id) => { const e = TIMINGS[id]; return e ? { startedAt: e[0], durationMs: e[1] } : undefined; },
    agent: laneInfo,
    now: () => now,
  };
  const nodes = [{ id: 'tester', parentId: 'eng' }, { id: 'eng', parentId: undefined }] as unknown as ProcessNode[];

  const views = new SessionViews({
    conversation: { laneColorOf: (id: string) => (id === 'eng' ? 1 : id === 'tester' ? 2 : undefined), getWorkTreeSources: () => sources, getTreeGlyphSet: () => 'rounded' },
    agentManager,
    processManager,
    fleetNodes: () => nodes,
    steer: (id: string, text: string): SteerResult => { log.steers.push({ id, text }); return { queued: true, messageId: `m${log.steers.length}` } as SteerResult; },
    killAgent: (id: string) => { log.killed.push(id); const r = records.get(id); if (r) r.status = 'cancelled'; return [id]; },
    mainBusy: () => true,
    mainModel: () => 'claude-opus-5-5',
    promptText: () => prompt,
    requestRender: () => {},
    now: () => now,
    pollMs: 0,
    copy: (text) => { log.copied.push(text); },
  });

  // Feed the dev server's output at the times it arrived.
  if (options.withProcess ?? true) {
    for (const [at, stream, text] of DEV_OUTPUT) {
      now = VIEW_NOW + at;
      (stream === 'stdout' ? proc.stdout : proc.stderr).push(text);
      views.poll();
    }
    now = VIEW_NOW;
  }

  return {
    views,
    log,
    setNow: (n) => { now = n; },
    setPrompt: (text) => { prompt = text; },
    finishAgent: (id) => { const r = records.get(id); if (r) { r.status = 'completed'; r.completedAt = now; } },
  };
}

/** The whole screen for a scene: header (+ chips), the view's body, the composer and status line. */
export function renderViewScreen(scene: ViewScene, width: number, height: number): Line[] {
  const views = scene.views;
  const frame = views.frame(width, FIXTURE_VERSION);
  const header: Line[] = frame ? [frame.header] : renderHeaderLine(width, 'claude-opus-5-5', undefined, undefined, FIXTURE_VERSION);
  const chips = views.chips(width);
  if (chips) header.push(chips);
  const footer = buildShellFooter({
    width, promptText: '', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
    runningAgentCount: 1, runningProcessCount: 1, indicatorFocused: false, view: frame?.footer ?? null,
    promptFocused: frame?.footer.disabledReason === undefined,
  }).lines;
  const bodyHeight = height - header.length - footer.length;
  const body = frame ? frame.body(bodyHeight) : Array.from({ length: bodyHeight }, () => {
    const line = createEmptyLine(width);
    for (const cell of line) cell.bg = '';
    return line;
  });
  return [...header, ...body, ...footer];
}
