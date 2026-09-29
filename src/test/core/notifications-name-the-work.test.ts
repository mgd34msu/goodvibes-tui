/**
 * Notifications name the work (owner ruling 2026-09-29).
 *
 * "notifications need to be a bit better. they work but don't convey any
 * useful information ... it should provide a summarized name for the turn"
 * and, on webhooks, "default the privacy setting to off".
 *
 * Every channel the TUI sends on is driven here through the real wiring and
 * read back: the desktop popup (the injected notifyDesktop), the in-terminal
 * OSC 9 notice (the terminal notifier's message) and the webhook body. Each is
 * checked for a completed, a failed and a cancelled turn, with the turn's name
 * trimmed at a word boundary, and again with
 * behavior.notificationsMetadataOnly on, where every channel carries metadata
 * only.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wireTurnEventHandlers, type WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { wrapRequestPermissionWithAlert } from '../../core/approval-alert.ts';
import type { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { FocusTracker } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import { ConfigManager, type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

const ASK = 'Refactor the authentication middleware so expired sessions redirect to the login page instead of throwing a 500 error';
const NAME_60 = 'Refactor the authentication middleware so expired sessions…';

/** True when `trimmed` is a whole-word prefix of `source` (ellipsis allowed). */
function isWordPrefix(trimmed: string, source: string): boolean {
  const head = trimmed.endsWith('…') ? trimmed.slice(0, -1) : trimmed;
  return source.startsWith(head) && (head.length === source.length || source[head.length] === ' ');
}

type Bus = { on(type: string, h: (e: unknown) => void): () => void; emit(type: string, e: unknown): void };
function bus(): Bus {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    on(type, h) {
      listeners.set(type, [...(listeners.get(type) ?? []), h]);
      return () => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== h));
    },
    emit(type, e) { for (const h of listeners.get(type) ?? []) h(e); },
  };
}

interface Captured {
  desktop: Array<{ title: string; body: string }>;
  terminal: Array<{ signal: string; message: string }>;
  webhook: string[];
}

function harness(config: Record<string, unknown> = {}, conversationTitle = '', titleSource = 'system') {
  const captured: Captured = { desktop: [], terminal: [], webhook: [] };
  const turns = bus(); const tools = bus(); const agents = bus(); const workflows = bus();
  let now = 1_000;
  const tracker = new FocusTracker();
  tracker.setFocused(false);
  const webhookNotifier = {
    getUrls: () => ['https://example.invalid/hook'],
    send: mock(async (text: string) => { captured.webhook.push(text); return {}; }),
  } as unknown as WebhookNotifier;
  const settings: Record<string, unknown> = { 'behavior.notifyAfterSeconds': 1, ...config };
  const options: WireTurnEventHandlersOptions = {
    // @ts-expect-error, duck-typed minimal fake for UiRuntimeEvents
    events: { turns, tools, agents, workflows },
    conversation: {
      toJSON: () => { throw new Error('stub: no persistence in this test'); },
      getTitleSource: () => titleSource,
      title: conversationTitle,
      getLastUserMessage: () => null,
      getMessageCount: () => 0,
    } as unknown as WireTurnEventHandlersOptions['conversation'],
    runtime: { sessionId: 'test-sess-id-001', model: 'm', provider: 'p' },
    orchestrator: { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    configManager: { get: (key: string) => settings[key] },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
    hookDispatcher: { fire: mock(async () => ({ ok: true })) } as unknown as WireTurnEventHandlersOptions['hookDispatcher'],
    surface: makeTestSurface('/tmp/notif-test-workdir', '/tmp/notif-test-home'),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier,
    focusTracker: tracker,
    terminalNotifier: { notify: (signal, message) => { captured.terminal.push({ signal, message }); } },
    notifyDesktop: (title, body) => { captured.desktop.push({ title, body }); },
    _clock: () => now,
  };
  wireTurnEventHandlers(options);
  return {
    captured,
    advance: (ms: number) => { now += ms; },
    turn: (type: string, payload: Record<string, unknown>) => turns.emit(type, { type, ...payload }),
    tool: (type: string, payload: Record<string, unknown>) => tools.emit(type, { type, ...payload }),
    agent: (type: string, payload: Record<string, unknown>) => agents.emit(type, { type, ...payload }),
    workflow: (type: string, payload: Record<string, unknown>) => workflows.emit(type, { type, ...payload }),
  };
}

/** A turn that writes two files through one call, starts an agent and gets a review score. */
function runTurn(h: ReturnType<typeof harness>, end: () => void): void {
  h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
  h.tool('TOOL_RECEIVED', { callId: 'c1', turnId: 't1', tool: 'write', args: { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] } });
  h.tool('TOOL_SUCCEEDED', { callId: 'c1', turnId: 't1', tool: 'write', durationMs: 5 });
  h.agent('AGENT_SPAWNING', { agentId: 'agent-1', task: 'Review the middleware change' });
  h.workflow('WORKFLOW_REVIEW_COMPLETED', { chainId: 'chain-1', score: 9, passed: true });
  h.advance(83_000);
  end();
}

const ENDINGS = {
  completed: (h: ReturnType<typeof harness>) => h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' }),
  failed: (h: ReturnType<typeof harness>) => h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502: upstream timed out', stopReason: 'provider_error' }),
  cancelled: (h: ReturnType<typeof harness>) => h.turn('TURN_CANCEL', { turnId: 't1', reason: 'cancelled', stopReason: 'cancelled' }),
} as const;

const EXPECTED_BODY = {
  completed: 'Done in 1m 23s, 2 files changed, 1 tool call, 1 agent started, review 9/10',
  failed: 'Failed after 1m 23s, 2 files changed, 1 tool call, 1 agent started, review 9/10: Provider returned HTTP 502: upstream timed out',
  cancelled: 'Cancelled after 1m 23s, 2 files changed, 1 tool call, 1 agent started, review 9/10',
} as const;

describe('a finished turn is named on every channel (privacy setting off, the default)', () => {
  for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
    describe(`${outcome} turn`, () => {
      test('desktop: title is the turn name trimmed at a word, body is the outcome', () => {
        const h = harness();
        runTurn(h, () => ENDINGS[outcome](h));
        expect(h.captured.desktop).toEqual([{ title: NAME_60, body: EXPECTED_BODY[outcome] }]);
        expect(isWordPrefix(h.captured.desktop[0]!.title, ASK)).toBe(true);
      });

      test('in-terminal (OSC 9): one line with the name and the outcome', () => {
        const h = harness();
        runTurn(h, () => ENDINGS[outcome](h));
        expect(h.captured.terminal).toHaveLength(1);
        const { signal, message } = h.captured.terminal[0]!;
        expect(signal).toBe('turn-end');
        expect(message.length).toBeLessThanOrEqual(140);
        const [name, ...rest] = message.split(': ');
        expect(isWordPrefix(name!, ASK)).toBe(true);
        expect(name!.endsWith('…')).toBe(true);
        expect(rest.join(': ').startsWith(EXPECTED_BODY[outcome].slice(0, 20))).toBe(true);
      });

      test('webhook: the name line, then the outcome line', () => {
        const h = harness();
        runTurn(h, () => ENDINGS[outcome](h));
        expect(h.captured.webhook).toEqual([`${NAME_60}\n${EXPECTED_BODY[outcome]}`]);
      });
    });
  }

  test('a user-set conversation title names the turn instead of the message', () => {
    const h = harness({}, 'Login redirect work', 'user');
    runTurn(h, () => ENDINGS.completed(h));
    expect(h.captured.desktop[0]!.title).toBe('Login redirect work');
  });

  test('a preflight failure is told as failed with its reason', () => {
    const h = harness();
    runTurn(h, () => h.turn('PREFLIGHT_FAIL', { turnId: 't1', reason: 'context window preflight failed', stopReason: 'context_overflow' }));
    expect(h.captured.desktop[0]!.body.startsWith('Failed after 1m 23s')).toBe(true);
    expect(h.captured.desktop[0]!.body.endsWith(': context window preflight failed')).toBe(true);
  });

  test('one notice per turn even when two terminal events arrive for it', () => {
    const h = harness();
    runTurn(h, () => { ENDINGS.failed(h); ENDINGS.completed(h); });
    expect(h.captured.desktop).toHaveLength(1);
    expect(h.captured.webhook).toHaveLength(1);
  });
});

describe('behavior.notificationsMetadataOnly on: every channel is metadata only', () => {
  for (const outcome of ['completed', 'failed', 'cancelled'] as const) {
    test(`${outcome} turn`, () => {
      const h = harness({ 'behavior.notificationsMetadataOnly': true });
      runTurn(h, () => ENDINGS[outcome](h));
      const word = outcome === 'completed' ? 'done' : outcome;
      const lead = outcome === 'completed' ? 'Done in 1m 23s' : `${outcome === 'failed' ? 'Failed' : 'Cancelled'} after 1m 23s`;
      const body = `${lead}, 2 files changed, 1 tool call, 1 agent started, review 9/10, session test-ses`;
      expect(h.captured.desktop).toEqual([{ title: `GoodVibes: turn ${word}`, body }]);
      expect(h.captured.terminal.map((c) => c.message)).toEqual([`GoodVibes: turn ${word}: ${body}`]);
      expect(h.captured.webhook).toEqual([`GoodVibes: turn ${word}\n${body}`]);
      const all = JSON.stringify(h.captured);
      expect(all).not.toContain('Refactor');
      expect(all).not.toContain('502');
    });
  }
});

describe('approval notices name the command and the turn', () => {
  function request(): PermissionPromptRequest {
    return {
      callId: 'c9', tool: 'exec', category: 'execute' as PermissionPromptRequest['category'],
      args: { commands: [{ cmd: 'bun test src/auth/middleware.test.ts' }] },
      analysis: {} as PermissionPromptRequest['analysis'],
    };
  }
  function run(config: Record<string, unknown>) {
    const captured: Captured = { desktop: [], terminal: [], webhook: [] };
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    const wrapped = wrapRequestPermissionWithAlert(async () => ({ approved: true, remember: false }), {
      focusTracker: tracker,
      configGet: (key) => config[key],
      webhookNotifier: {
        getUrls: () => ['https://example.invalid/hook'],
        send: mock(async (text: string) => { captured.webhook.push(text); return {}; }),
      } as unknown as WebhookNotifier,
      terminalNotifier: { notify: (signal, message) => { captured.terminal.push({ signal, message }); } },
      conversation: { title: 'first message', getTitleSource: () => 'system', getLastUserMessage: () => ASK },
      notifyDesktop: (title, body) => { captured.desktop.push({ title, body }); },
    });
    return wrapped(request()).then(() => captured);
  }

  test('privacy off: desktop, OSC 9 and webhook carry the command and the turn name', async () => {
    const captured = await run({});
    const title = captured.desktop[0]!.title;
    expect(title.startsWith('Approval needed: ')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(isWordPrefix(title.slice('Approval needed: '.length), ASK)).toBe(true);
    expect(captured.desktop[0]!.body).toBe('exec is waiting for approval: bun test src/auth/middleware.test.ts');
    expect(captured.terminal[0]!.signal).toBe('approval-wait');
    expect(captured.terminal[0]!.message).toContain('bun test src/auth/middleware.test.ts');
    expect(captured.terminal[0]!.message).toContain('Approval needed: Refactor');
    expect(captured.webhook[0]).toBe(`${title}\nexec is waiting for approval: bun test src/auth/middleware.test.ts`);
  });

  test('privacy on: tool and category only on every channel', async () => {
    const captured = await run({ 'behavior.notificationsMetadataOnly': true });
    expect(captured.desktop).toEqual([{ title: 'GoodVibes: approval needed', body: 'exec (execute) is waiting for approval' }]);
    expect(captured.terminal[0]!.message).toBe('GoodVibes: approval needed: exec (execute) is waiting for approval');
    expect(captured.webhook).toEqual(['GoodVibes: approval needed\nexec (execute) is waiting for approval']);
  });
});

describe('budget, agent and workstream notices name the work', () => {
  const PRICED = 'claude-sonnet-4-6';
  function budgetHarness(config: Record<string, unknown>) {
    const captured: Captured = { desktop: [], terminal: [], webhook: [] };
    const h = harness({ 'behavior.notifyAfterSeconds': 0, 'behavior.budgetAlertUsd': 1, ...config });
    return { h, captured };
  }

  test('budget: names the budget that tripped and the turn it tripped in', () => {
    // A separate harness: the budget needs a priced model and a real cost.
    const captured: Captured = { desktop: [], terminal: [], webhook: [] };
    const turns = bus(); const tools = bus(); const agents = bus(); const workflows = bus();
    const tracker = new FocusTracker();
    tracker.setFocused(false);
    for (const metadataOnly of [false, true]) {
      captured.desktop.length = 0; captured.webhook.length = 0;
      const settings: Record<string, unknown> = { 'behavior.notifyAfterSeconds': 0, 'behavior.budgetAlertUsd': 1, 'behavior.notificationsMetadataOnly': metadataOnly };
      const unsub = wireTurnEventHandlers({
        // @ts-expect-error, duck-typed minimal fake for UiRuntimeEvents
        events: { turns, tools, agents, workflows },
        conversation: { toJSON: () => { throw new Error('stub'); }, getTitleSource: () => 'system', title: '', getLastUserMessage: () => null, getMessageCount: () => 0 } as unknown as WireTurnEventHandlersOptions['conversation'],
        runtime: { sessionId: 'budget-sess-01', model: 'm', provider: 'p' },
        orchestrator: { lastInputTokens: 0, usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
        configManager: { get: (key: string) => settings[key] },
        providerRegistry: { getCurrentModel: () => ({ contextWindow: 200_000, id: PRICED }), getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow },
        systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
        hookDispatcher: { fire: mock(async () => ({ ok: true })) } as unknown as WireTurnEventHandlersOptions['hookDispatcher'],
        surface: makeTestSurface('/tmp/notif-test-workdir', '/tmp/notif-test-home'),
        gitStatusProvider: { refresh: async () => null },
        lastGitInfoRef: { value: null },
        buildSessionContinuityHints: () => ({}),
        render: () => {},
        webhookNotifier: { getUrls: () => ['https://example.invalid/hook'], send: mock(async (t: string) => { captured.webhook.push(t); return {}; }) } as unknown as WebhookNotifier,
        focusTracker: tracker,
        notifyDesktop: (title, body) => { captured.desktop.push({ title, body }); },
        _clock: () => 0,
      });
      turns.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: `b-${metadataOnly}`, prompt: ASK });
      turns.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: `b-${metadataOnly}`, response: 'ok', stopReason: 'completed' });
      for (const u of unsub.unsubs) u();
      if (!metadataOnly) {
        expect(captured.desktop).toHaveLength(1);
        expect(captured.desktop[0]!.title.startsWith('Budget passed: Refactor the authentication')).toBe(true);
        expect(captured.desktop[0]!.title.length).toBeLessThanOrEqual(60);
        expect(captured.desktop[0]!.body).toBe('Session cost $30.00 passed the $1.00 session budget during this turn');
        expect(captured.webhook[0]).toBe(`${captured.desktop[0]!.title}\n${captured.desktop[0]!.body}`);
      } else {
        expect(captured.desktop).toEqual([{ title: 'GoodVibes: budget passed', body: 'Session cost $30.00 passed the $1.00 budget, session budget-s' }]);
        expect(captured.webhook).toEqual(['GoodVibes: budget passed\nSession cost $30.00 passed the $1.00 budget, session budget-s']);
      }
    }
  });

  test('agent failure and agent-blocked name the agent task; privacy on falls back to the id', () => {
    for (const metadataOnly of [false, true]) {
      const { h } = budgetHarness({ 'behavior.notificationsMetadataOnly': metadataOnly });
      h.agent('AGENT_SPAWNING', { agentId: 'agent-12345678', task: 'Audit the retry backoff in the HTTP client' });
      h.agent('AGENT_AWAITING_MESSAGE', { agentId: 'agent-12345678' });
      h.agent('AGENT_FAILED', { agentId: 'agent-12345678', error: 'ran out of turns', durationMs: 5 });
      if (!metadataOnly) {
        expect(h.captured.terminal.map((c) => c.message)).toEqual(['Agent waiting for your input: Audit the retry backoff in the HTTP client']);
        expect(h.captured.desktop).toEqual([{ title: 'Agent failed: Audit the retry backoff in the HTTP client', body: 'agent agent-12 failed: ran out of turns' }]);
      } else {
        expect(h.captured.terminal.map((c) => c.message)).toEqual(['agent agent-12 is waiting for your input']);
        expect(h.captured.desktop).toEqual([{ title: 'GoodVibes: agent failed', body: 'agent agent-12 failed' }]);
      }
    }
  });

  test('workstream failure names the task and the last review score; privacy on drops both', () => {
    for (const metadataOnly of [false, true]) {
      const { h } = budgetHarness({ 'behavior.notificationsMetadataOnly': metadataOnly });
      h.workflow('WORKFLOW_CHAIN_CREATED', { chainId: 'chain-abc', task: 'Rewrite the retry backoff so it honors Retry-After headers from every provider' });
      h.workflow('WORKFLOW_REVIEW_COMPLETED', { chainId: 'chain-abc', score: 4, passed: false });
      h.workflow('WORKFLOW_CHAIN_FAILED', { chainId: 'chain-abc', reason: 'review scored 4/10 after 3 fix attempts', failureKind: 'other' });
      if (!metadataOnly) {
        const [{ title, body }] = h.captured.desktop as [{ title: string; body: string }];
        expect(title.startsWith('Workstream failed: Rewrite the retry backoff')).toBe(true);
        expect(title.length).toBeLessThanOrEqual(60);
        expect(isWordPrefix(title.slice('Workstream failed: '.length), 'Rewrite the retry backoff so it honors Retry-After headers from every provider')).toBe(true);
        expect(body).toBe('Failed: review scored 4/10 after 3 fix attempts (last review 4/10)');
      } else {
        expect(h.captured.desktop).toEqual([{ title: 'GoodVibes: workstream failed', body: 'Failed' }]);
      }
    }
  });
});

describe('the privacy setting in the settings modal', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let dir: string;
  let cm: ConfigManager;
  beforeEach(() => {
    dir = join(tmpdir(), `gv-notif-privacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    process.env.HOME = dir;
    process.chdir(dir);
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: dir, homeDir: dir, configDir: join(dir, '.goodvibes', 'global-tui') });
  });
  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test('behavior lists behavior.notificationsMetadataOnly once, boolean, default off, right after the notification rows', () => {
    const rows = buildSettingGroups(cm).get('behavior') ?? [];
    const keys = rows.map((row) => row.setting.key as string);
    expect(keys.filter((key) => key === 'behavior.notificationsMetadataOnly')).toHaveLength(1);
    const row = rows.find((r) => (r.setting.key as string) === 'behavior.notificationsMetadataOnly')!;
    expect(row.setting.type).toBe('boolean');
    expect(row.setting.default).toBe(false);
    expect(row.currentValue).toBe(false);
    expect(row.setting.description).toContain('metadata only');
    expect(keys.indexOf('behavior.notificationsMetadataOnly')).toBe(keys.indexOf('behavior.terminalBell') + 1);
  });

  test('turning it on is a real, persisted config value', () => {
    cm.set('behavior.notificationsMetadataOnly' as ConfigKey, true as never);
    const row = (buildSettingGroups(cm).get('behavior') ?? []).find((r) => (r.setting.key as string) === 'behavior.notificationsMetadataOnly')!;
    expect(row.currentValue).toBe(true);
    expect(row.isDefault).toBe(false);
  });
});
