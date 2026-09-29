/**
 * work-tree-scenes.ts, the concept page's work-tree scenes as transcripts.
 *
 * Each scene is a message transcript plus the live facts the work tree reads
 * (timings, agent lanes, the call waiting on a prompt), fold state and focus.
 * Golden frames and the preview script render them through the real
 * appendConversationMessages path. Times are fixed so frames are deterministic.
 */

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import type { AgentLaneInfo, CallTiming, WorkTreeSources, WrfcPhaseInfo } from '../../core/work-tree-sources.ts';

type Message = ConversationMessageSnapshot;

export interface WorkTreeScene {
  readonly name: string;
  readonly messages: Message[];
  readonly sources: WorkTreeSources;
  readonly collapse: Map<string, boolean>;
  readonly focusId: string | null;
}

/** The fixed clock every scene renders at. */
export const SCENE_NOW = 1_800_000_000_000;
const T0 = SCENE_NOW - 400_000;
const MODEL = 'claude-opus-5-5';

const user = (content: string): Message => ({ role: 'user', content });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const assistant = (content: string, toolCalls?: ToolCall[]): Message => ({ role: 'assistant', content, model: MODEL, provider: 'anthropic', ...(toolCalls ? { toolCalls } : {}) });
const result = (callId: string, toolName: string, content: string): Message => ({ role: 'tool', callId, toolName, content });

/** Source text read results carry, cycled to the requested length. */
const FILE_TEXT = [
  'export interface RetryOptions {',
  '  attempts: number;',
  '  baseDelayMs: number;',
  '}',
  '',
  'export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {',
  '  let lastError: unknown;',
  '  for (let i = 0; i < opts.attempts; i++) {',
  '    try {',
  '      return await fn();',
  '    } catch (err) {',
  '      lastError = err;',
  '      await sleep(opts.baseDelayMs);',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
  '',
  'const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));',
  '',
];
/** A read result in the read tool's default (standard) format: the file text, line-numbered. */
const readResult = (path: string, lines: number): string => JSON.stringify({
  success: true,
  summary: { files_read: 1, total_lines: lines },
  files: [{ path, lineCount: lines, content: Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(5)} | ${FILE_TEXT[i % FILE_TEXT.length]}`).join('\n') }],
});
const findResult = (matches: Array<[string, number, string]>): string => JSON.stringify({ q1: { matches: matches.map(([file, line, text]) => ({ file, line, text })), count: matches.length } });
const execResult = (cmd: string, exit: number, stdout: string, stderr = ''): string => JSON.stringify({ cmd, exit_code: exit, stdout, stderr, success: exit === 0, duration_ms: 1400 });
const spawnResult = (agentId: string, template: string, task: string): string => JSON.stringify({ agentId, status: 'spawned', template, task });

const RETRY_DIFF = [
  'Edits applied: 1, failed: 0',
  '',
  '--- src/net/retry.ts (1 replacement(s)) ---',
  'diff --git a/src/net/retry.ts b/src/net/retry.ts',
  '--- a/src/net/retry.ts',
  '+++ b/src/net/retry.ts',
  '@@ -12,5 +12,7 @@',
  '       lastError = err;',
  '-      await sleep(opts.baseDelayMs);',
  '+      if (i === opts.attempts - 1) break;',
  '+      const backoff = opts.baseDelayMs * 2 ** i;',
  '+      await sleep(backoff + Math.random() * backoff * 0.2);',
  '     }',
].join('\n');

const TEST_OUTPUT = [
  '✓ withRetry > returns the first successful result [0.41ms]',
  '✓ withRetry > backs off exponentially between attempts [3.12ms]',
  '✓ withRetry > does not sleep after the final attempt [0.88ms]',
  '✓ withRetry > rethrows the last error [0.27ms]',
  '',
  ' 4 pass',
  ' 0 fail',
].join('\n');

function timingSource(entries: Record<string, [number, number | undefined]>): (id: string) => CallTiming | undefined {
  return (id) => {
    const e = entries[id];
    return e ? { startedAt: T0 + e[0], durationMs: e[1] } : undefined;
  };
}

function agentInfo(partial: Partial<AgentLaneInfo> & Pick<AgentLaneInfo, 'id' | 'name' | 'task' | 'messages'>): AgentLaneInfo {
  return { status: 'completed', toolCallCount: partial.messages.reduce((n, m) => n + (m.role === 'assistant' ? m.toolCalls?.length ?? 0 : 0), 0), ...partial };
}

/** The retry-helper turn's calls and results. */
function retryTurn(open: { read?: boolean; edit?: boolean; exec?: boolean } = {}): { messages: Message[]; collapse: Map<string, boolean> } {
  const messages: Message[] = [
    user("The retry helper in src/net/retry.ts never backs off, so we hammer the API when it's down. Can you fix it and add a test?"),
    assistant("Let me look at the current implementation and where it's used.", [
      call('c-read', 'read', { files: [{ path: 'src/net/retry.ts' }] }),
      call('c-find', 'find', { queries: [{ id: 'q1', mode: 'content', pattern: 'withRetry' }] }),
      call('c-edit', 'edit', { edits: [{ path: 'src/net/retry.ts', find: '      await sleep(opts.baseDelayMs);', replace: '      if (i === opts.attempts - 1) break;\n      const backoff = opts.baseDelayMs * 2 ** i;\n      await sleep(backoff + Math.random() * backoff * 0.2);' }], output: { format: 'with_diff' } }),
      call('c-exec', 'exec', { command: 'bun test test/retry.test.ts' }),
    ]),
    result('c-read', 'read', readResult('src/net/retry.ts', 20)),
    result('c-find', 'find', findResult([['src/net/retry.ts', 4, 'export async function withRetry<T>('], ['src/api/client.ts', 31, 'return withRetry(() => fetchJson(url), opts);'], ['test/retry.test.ts', 2, "import { withRetry } from '../src/net/retry';"]])),
    result('c-edit', 'edit', RETRY_DIFF),
    result('c-exec', 'exec', execResult('bun test test/retry.test.ts', 0, TEST_OUTPUT)),
    assistant('**Fixed: exponential backoff with jitter**\n\nThe loop slept a constant baseDelayMs between attempts, so a flapping API got hit at a steady rate. The delay now doubles each attempt with up to 20% jitter, and there is no sleep after the last try.'),
  ];
  const collapse = new Map<string, boolean>();
  if (open.read) collapse.set('bead_c:1:0', false);
  if (open.edit) collapse.set('bead_c:1:2', false);
  if (open.exec) collapse.set('bead_c:1:3', false);
  return { messages, collapse };
}

const retryTimings = timingSource({ 'c-read': [0, 200], 'c-find': [300, 100], 'c-edit': [500, 300], 'c-exec': [900, 1400] });

/** flow: a single lane, one finished turn, and a folded earlier turn below it. */
export function singleLaneScene(): WorkTreeScene {
  const { messages, collapse } = retryTurn();
  messages.push(
    user('also add a maxDelayMs cap to withRetry'),
    assistant('', [call('c2-spawn', 'agent', { mode: 'spawn', template: 'engineer', task: 'add a maxDelayMs cap' })]),
    result('c2-spawn', 'agent', spawnResult('eng-cap', 'engineer', 'add a maxDelayMs cap')),
    assistant('Added the maxDelayMs cap through a subagent and re-ran the suite.'),
  );
  collapse.set('turn_8', true);
  return {
    name: 'single-lane',
    messages,
    collapse,
    focusId: null,
    sources: {
      callTiming: retryTimings,
      turnTiming: (i) => (i === 0 ? { startedAt: T0, endedAt: T0 + 1900 } : i === 7 ? { startedAt: T0 + 5000, endedAt: T0 + 5000 + 182_000 } : undefined),
      agent: (id) => (id === 'eng-cap' ? agentInfo({ id, name: 'engineer', task: 'add a maxDelayMs cap', messages: [], toolCallCount: 6, startedAt: T0 + 6000, completedAt: T0 + 140_000, costUsd: 0.12 }) : null),
      now: () => SCENE_NOW,
    },
  };
}

/** flow-open: the read, the edit and the exec opened, the edit focused. */
export function openBeadScene(): WorkTreeScene {
  const { messages, collapse } = retryTurn({ read: true, edit: true, exec: true });
  return {
    name: 'open-bead',
    messages,
    collapse,
    focusId: 'c:1:2',
    sources: { callTiming: retryTimings, turnTiming: (i) => (i === 0 ? { startedAt: T0, endedAt: T0 + 1900 } : undefined), now: () => SCENE_NOW },
  };
}

/** flow-lanes: an engineer, a WRFC chain and a hosted agent running side by side. */
export function lanesScene(): WorkTreeScene {
  const messages: Message[] = [
    user('Add a maxDelayMs cap, get it reviewed, and document retry.'),
    assistant('Splitting this up: one agent adds the cap, a WRFC chain reviews it, Claude Code writes the docs.', [
      call('m-read', 'read', { files: [{ path: 'src/net/retry.ts' }] }),
      call('m-eng', 'agent', { mode: 'spawn', template: 'engineer', task: 'add a maxDelayMs cap' }),
      call('m-wrfc', 'agent', { mode: 'spawn', template: 'engineer', task: 'review the cap' }),
      call('m-cc', 'agent', { mode: 'spawn', template: 'general', task: 'write retry docs' }),
    ]),
    result('m-read', 'read', readResult('src/net/retry.ts', 20)),
    result('m-eng', 'agent', spawnResult('eng', 'engineer', 'add a maxDelayMs cap')),
    result('m-wrfc', 'agent', spawnResult('wrfc', 'engineer', 'review the cap')),
    result('m-cc', 'agent', spawnResult('cc', 'general', 'write retry docs')),
    assistant('', [
      call('m-test', 'exec', { command: 'bun test' }),
      call('m-dev', 'exec', { command: 'bun run dev', background: true }),
    ]),
    result('m-test', 'exec', execResult('bun test', 0, ' 128 pass\n 0 fail')),
    result('m-dev', 'exec', JSON.stringify({ cmd: 'bun run dev', pid: 48213, background: true, note: 'listening on http://localhost:5173' })),
    assistant('Cap added and reviewed; the docs are still being written.'),
  ];
  const engMessages: Message[] = [
    assistant('', [call('e-read', 'read', { files: [{ path: 'src/net/retry.ts' }] }), call('e-edit', 'edit', { edits: [{ path: 'src/net/retry.ts', find: '      await sleep(backoff);', replace: '      await sleep(Math.min(backoff, opts.maxDelayMs));' }] })]),
    result('e-read', 'read', readResult('src/net/retry.ts', 20)),
    result('e-edit', 'edit', JSON.stringify({ applied: 1, failed: 0, dry_run: false })),
    assistant('', [call('e-test', 'exec', { command: 'bun test' }), call('e-fix', 'edit', { edits: [{ path: 'src/net/retry.ts', find: '      await sleep(Math.min(backoff, opts.maxDelayMs));', replace: '      await sleep(Math.min(backoff + jitter, opts.maxDelayMs));' }] })]),
    result('e-test', 'exec', execResult('bun test', 0, ' 6 pass\n 0 fail')),
    result('e-fix', 'edit', JSON.stringify({ applied: 1, failed: 0, dry_run: false })),
  ];
  const ccMessages: Message[] = [
    assistant('', [call('cc-edit', 'edit', { edits: [{ path: 'docs/retry.md', find: '# Retry', replace: '# Retry\n\nwithRetry retries with exponential backoff and jitter.' }] }), call('cc-lint', 'exec', { command: 'markdownlint docs/' }), call('cc-edit2', 'edit', { edits: [{ path: 'docs/retry.md', find: 'jitter.', replace: 'jitter, capped at maxDelayMs.' }] })]),
    result('cc-edit', 'edit', JSON.stringify({ applied: 1, failed: 0, dry_run: false })),
  ];
  const phases: WrfcPhaseInfo[] = [
    { agentId: 'w1', role: 'engineer', task: 'engineer output accepted', status: 'completed', startedAt: T0 + 5000, completedAt: T0 + 5000 },
    { agentId: 'w2', role: 'reviewer', task: 'review the cap', status: 'completed', startedAt: T0 + 9000, completedAt: T0 + 79_000, findings: ['jitter can push the delay past maxDelayMs'], passed: false },
    { agentId: 'w3', role: 'fixer', task: 'clamp after adding jitter', status: 'completed', startedAt: T0 + 80_000, completedAt: T0 + 80_400 },
    { agentId: 'w4', role: 'reviewer', task: 'finding resolved', status: 'completed', startedAt: T0 + 81_000, completedAt: T0 + 81_900, findings: [], passed: true },
  ];
  return {
    name: 'lanes',
    messages,
    collapse: new Map(),
    focusId: null,
    sources: {
      callTiming: timingSource({
        'm-read': [0, 200], 'm-eng': [1000, 50], 'e-read': [2000, 100], 'm-wrfc': [4000, 50], 'e-edit': [6000, 200],
        'm-cc': [12_000, 50], 'e-test': [20_000, 1600], 'e-fix': [85_000, 400], 'cc-edit': [150_000, 300],
        'm-test': [160_000, 6200], 'm-dev': [170_000, 720_000], 'cc-lint': [SCENE_NOW - T0 - 4000, undefined], 'cc-edit2': [SCENE_NOW - T0 - 1000, undefined],
      }),
      turnTiming: (i) => (i === 0 ? { startedAt: T0 } : undefined),
      agent: (id) => {
        if (id === 'eng') return agentInfo({ id, name: 'engineer', task: 'add a maxDelayMs cap', messages: engMessages, startedAt: T0 + 1000, completedAt: T0 + 135_000, costUsd: 0.12 });
        if (id === 'wrfc') return agentInfo({ id, name: 'engineer', task: 'review the cap', messages: [], toolCallCount: 0, wrfcPhases: phases, wrfcPassed: true, startedAt: T0 + 4000, completedAt: T0 + 82_000, costUsd: 0.31 });
        if (id === 'cc') return agentInfo({ id, name: 'general', hostedLabel: 'Claude Code', task: 'write retry docs', messages: ccMessages, status: 'running', startedAt: T0 + 12_000 });
        return null;
      },
      turnActive: () => false,
      now: () => SCENE_NOW,
    },
  };
}

/** flow-nested: engineer → tester → researcher, a failure carried back up. */
export function nestedScene(): WorkTreeScene {
  const messages: Message[] = [
    user('Add a maxDelayMs cap and make sure it is tested.'),
    assistant('Handing the cap to an engineer; it will get its own tests written and checked.', [
      call('n-read', 'read', { files: [{ path: 'src/net/retry.ts' }] }),
      call('n-eng', 'agent', { mode: 'spawn', template: 'engineer', task: 'add a maxDelayMs cap' }),
    ]),
    result('n-read', 'read', readResult('src/net/retry.ts', 20)),
    result('n-eng', 'agent', spawnResult('eng', 'engineer', 'add a maxDelayMs cap')),
    assistant('Cap added, tested, and passing.'),
  ];
  const eng: Message[] = [
    assistant('', [call('ne-edit', 'edit', { edits: [{ path: 'src/net/retry.ts', find: 'a', replace: 'b' }] }), call('ne-tester', 'agent', { mode: 'spawn', template: 'tester', task: 'cover the cap with tests' })]),
    result('ne-edit', 'edit', JSON.stringify({ applied: 1, failed: 0 })),
    result('ne-tester', 'agent', spawnResult('tester', 'tester', 'cover the cap with tests')),
    assistant('', [call('ne-fix', 'edit', { edits: [{ path: 'src/net/retry.ts', find: 'b', replace: 'c' }] }), call('ne-test', 'exec', { command: 'bun test' })]),
    result('ne-fix', 'edit', JSON.stringify({ applied: 1, failed: 0 })),
    result('ne-test', 'exec', execResult('bun test', 0, ' 8 pass\n 0 fail')),
  ];
  const tester: Message[] = [
    assistant('', [call('nt-read', 'read', { files: [{ path: 'test/retry.test.ts' }] }), call('nt-res', 'agent', { mode: 'spawn', template: 'researcher', task: 'how do others test jittered backoff?' })]),
    result('nt-read', 'read', readResult('test/retry.test.ts', 48)),
    result('nt-res', 'agent', spawnResult('res', 'researcher', 'how do others test jittered backoff?')),
    assistant('', [call('nt-edit', 'edit', { edits: [{ path: 'test/retry.test.ts', find: '});', replace: '});\n\nit("never sleeps longer than maxDelayMs", async () => {});' }] }), call('nt-exec', 'exec', { command: 'bun test test/retry.test.ts' })]),
    result('nt-edit', 'edit', JSON.stringify({ applied: 1, failed: 0 })),
    result('nt-exec', 'exec', 'Error: exit code 1\n2 failing'),
  ];
  const researcher: Message[] = [
    assistant('', [call('nr-find', 'find', { queries: [{ id: 'q1', mode: 'content', pattern: 'fake timers in bun:test' }] }), call('nr-fetch', 'fetch', { urls: [{ url: 'bun.sh/docs/test/time' }] })]),
    result('nr-find', 'find', findResult([['docs/a.md', 1, 'x'], ['docs/b.md', 2, 'y'], ['docs/c.md', 3, 'z'], ['docs/d.md', 4, 'w'], ['docs/e.md', 5, 'v'], ['docs/f.md', 6, 'u']])),
    result('nr-fetch', 'fetch', 'x'.repeat(4200)),
  ];
  return {
    name: 'nested',
    messages,
    collapse: new Map(),
    focusId: null,
    sources: {
      callTiming: timingSource({ 'n-read': [0, 200], 'ne-edit': [2000, 200], 'nt-read': [4000, 100], 'nr-find': [6000, 300], 'nr-fetch': [7000, 800], 'nt-edit': [20_000, 200], 'nt-exec': [21_000, 1200], 'ne-fix': [40_000, 200], 'ne-test': [41_000, 1500] }),
      turnTiming: (i) => (i === 0 ? { startedAt: T0, endedAt: T0 + 312_000 } : undefined),
      agent: (id) => {
        if (id === 'eng') return agentInfo({ id, name: 'engineer', task: 'add a maxDelayMs cap', messages: eng, startedAt: T0 + 1000, completedAt: T0 + 50_000, costUsd: 0.21 });
        if (id === 'tester') return agentInfo({ id, name: 'tester', task: 'cover the cap with tests', messages: tester, startedAt: T0 + 3000, completedAt: T0 + 30_000 });
        if (id === 'res') return agentInfo({ id, name: 'researcher', task: 'how do others test jittered backoff?', messages: researcher, startedAt: T0 + 5000, completedAt: T0 + 10_000 });
        return null;
      },
      now: () => SCENE_NOW,
    },
  };
}

/** flow-states: failed (opened), waiting on the user, cancelled, running. */
export function statesScene(): WorkTreeScene {
  const messages: Message[] = [
    user('The build is broken, can you fix it?'),
    assistant('', [
      call('s-read', 'read', { files: [{ path: 'src/api/client.ts' }] }),
      call('s-build', 'exec', { command: 'bun run build' }),
    ]),
    result('s-read', 'read', readResult('src/api/client.ts', 88)),
    result('s-build', 'exec', "Error: exit code 1\nerror TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.\n  src/api/client.ts:31:18"),
    assistant('', [
      call('s-edit', 'edit', { edits: [{ path: 'src/api/client.ts', find: 'fetchJson(url)', replace: 'fetchJson(url ?? DEFAULT_URL)' }] }),
      call('s-tester', 'agent', { mode: 'spawn', template: 'tester', task: 'verify the fix' }),
      call('s-clean', 'exec', { command: 'rm -rf dist && bun run build' }),
      call('s-watch', 'exec', { command: 'bun test --watch' }),
    ]),
    result('s-edit', 'edit', JSON.stringify({ applied: 1, failed: 0 })),
    result('s-tester', 'agent', spawnResult('tester', 'tester', 'verify the fix')),
    result('s-watch', 'exec', 'Error: cancelled by user'),
  ];
  const tester: Message[] = [
    assistant('', [call('st-find', 'find', { queries: [{ id: 'q1', mode: 'content', pattern: 'fetchJson callers' }] }), call('st-test', 'exec', { command: 'bun test test/api' })]),
  ];
  const collapse = new Map<string, boolean>([['bead_c:1:1', false]]);
  return {
    name: 'states',
    messages,
    collapse,
    focusId: null,
    sources: {
      callTiming: timingSource({ 's-read': [0, 100], 's-build': [500, 4200], 's-edit': [6000, 200], 's-tester': [7000, 50], 'st-find': [SCENE_NOW - T0 - 3000, undefined], 's-clean': [SCENE_NOW - T0 - 12_000, undefined], 's-watch': [SCENE_NOW - T0 - 11_000, undefined], 'st-test': [SCENE_NOW - T0 - 1000, undefined] }),
      turnTiming: (i) => (i === 0 ? { startedAt: SCENE_NOW - 38_000 } : undefined),
      agent: (id) => (id === 'tester' ? agentInfo({ id, name: 'tester', task: 'verify the fix', messages: tester, status: 'running', startedAt: T0 + 7000 }) : null),
      waitingCallIds: () => new Set(['s-clean']),
      turnActive: () => true,
      now: () => SCENE_NOW,
    },
  };
}

/** flow-folded: two finished lanes folded to ◉ beads, one still running. */
export function foldedScene(): WorkTreeScene {
  const base = lanesScene();
  const collapse = new Map<string, boolean>([['lane_eng', true], ['lane_wrfc', true]]);
  return { ...base, name: 'folded', collapse };
}

export const WORK_TREE_SCENES: ReadonlyArray<() => WorkTreeScene> = [singleLaneScene, openBeadScene, lanesScene, nestedScene, statesScene, foldedScene];
