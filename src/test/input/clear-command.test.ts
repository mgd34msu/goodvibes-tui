/**
 * /clear starts a fresh conversation: the header's title and the status
 * line's context usage describe the new, empty conversation, and the old one
 * is saved as its own session rather than lost.
 *
 * Live run on 14d4e369: /clear only hid the transcript while keeping every
 * message in the model's context, so the header kept "Fix retry backoff" and
 * the status line kept the old context usage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { clearTurnAnchors, getTurnAnchors, recordTurnAnchor } from '@pellux/goodvibes-sdk/platform/rewind';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShellCoreCommands } from '../../input/commands/shell-core.ts';
import { ConversationManager, sumConversationUsage } from '../../core/conversation.ts';
import { loadWorkTreeTurnOutcomes } from '../../core/work-tree-fold-store.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(options: { generating?: boolean; failSave?: boolean } = {}) {
  const dir = makeProjectTempDir('gv-clear');
  dirs.push(dir);
  const surface = makeTestSurface(dir);
  const sessionManager = new SessionManager(dir, { surface });
  if (options.failSave) sessionManager.save = () => { throw new Error('disk full'); };
  const conversation = new ConversationManager(() => 100);
  conversation.addUserMessage('The retry helper never backs off');
  conversation.addAssistantMessage('Fixed.', { model: 'm1', usage: { inputTokens: 13_000, outputTokens: 400 } });
  conversation.title = 'Fix retry backoff';
  conversation.workTree.recordTurnOutcome({ index: 0, fingerprint: '1:x', outcome: 'failed' });
  const orchestrator = { usage: { input: 13_000, output: 400, cacheRead: 0, cacheWrite: 0 }, lastInputTokens: 13_000 };
  const printed: string[] = [];
  const toasts: string[] = [];
  const runtime = { model: 'm1', provider: 'p', debugMode: false, systemPrompt: 'old prompt', reasoningEffort: '', sessionId: 'user-live' };
  const ctx = {
    session: {
      runtime,
      conversationManager: conversation,
      sessionManager,
      hydrateSessionUsage: () => {
        const { usage, lastInputTokens } = sumConversationUsage(conversation.getMessageSnapshot());
        orchestrator.usage = usage;
        orchestrator.lastInputTokens = lastInputTokens;
      },
    },
    workspace: { surface },
    reloadSystemPrompt: () => 'fresh prompt',
    isGenerating: () => options.generating === true,
    showToast: (t: { title: string; body?: string }) => { toasts.push(`${t.title}: ${t.body ?? ''}`); },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerShellCoreCommands(registry);
  return { ctx, registry, conversation, orchestrator, printed, toasts, runtime, surface, sessionManager, dir };
}

describe('/clear starts a fresh conversation', () => {
  test('the header title and the context usage describe the empty conversation', async () => {
    const s = setup();
    await s.registry.execute('clear', [], s.ctx);
    expect(s.conversation.title).toBe('');
    expect(s.conversation.getMessageSnapshot()).toHaveLength(0);
    expect(s.orchestrator.lastInputTokens).toBe(0);
    expect(s.orchestrator.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(s.runtime.systemPrompt).toBe('fresh prompt');
    expect(s.runtime.sessionId).toBe('user-live');
    expect(s.conversation.workTree.turnOutcome(0)).toBeUndefined();
  });

  test('the previous conversation is saved as its own resumable session, with its view', async () => {
    const s = setup();
    recordTurnAnchor('user-live', { turnId: 't1', label: 'retry', messageCount: 2, at: 1 });
    await s.registry.execute('clear', [], s.ctx);
    expect(s.toasts).toHaveLength(1);
    const savedAs = /saved as (user-[0-9a-f]{8})/.exec(s.toasts[0]!)?.[1];
    expect(savedAs).toBeDefined();
    const loaded = s.sessionManager.load(savedAs!);
    expect(loaded.meta.title).toBe('Fix retry backoff');
    expect(loaded.messages.map((m) => (m as { content?: unknown }).content)).toEqual(['The retry helper never backs off', 'Fixed.']);
    expect(loadWorkTreeTurnOutcomes(s.surface.sessionsDir, savedAs!)).toEqual([{ index: 0, fingerprint: '1:x', outcome: 'failed' }]);
    // The anchors go with the saved transcript; the live session starts with none.
    expect(getTurnAnchors(savedAs!).map((a) => a.turnId)).toEqual(['t1']);
    expect(getTurnAnchors('user-live')).toHaveLength(0);
    clearTurnAnchors(savedAs!);
  });

  test('the live session\'s old anchor sidecar is removed', async () => {
    const s = setup();
    const sidecar = join(s.surface.sessionsDir, 'user-live.anchors.json');
    mkdirSync(s.surface.sessionsDir, { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ version: 1, sessionId: 'user-live', anchors: [] }));
    await s.registry.execute('clear', [], s.ctx);
    expect(existsSync(sidecar)).toBe(false);
    const view = JSON.parse(readFileSync(join(s.surface.sessionsDir, 'user-live.work-tree.json'), 'utf8')) as { folds: object; turns?: unknown };
    expect(view.folds).toEqual({});
    expect(view.turns).toBeUndefined();
  });

  test('refused while a turn runs: nothing changes', async () => {
    const s = setup({ generating: true });
    await s.registry.execute('clear', [], s.ctx);
    expect(s.conversation.title).toBe('Fix retry backoff');
    expect(s.conversation.getMessageSnapshot()).toHaveLength(2);
    expect(s.printed.join('\n')).toContain('still running');
  });

  test('a failed save clears nothing', async () => {
    const s = setup({ failSave: true });
    await s.registry.execute('clear', [], s.ctx);
    expect(s.conversation.getMessageSnapshot()).toHaveLength(2);
    expect(s.orchestrator.lastInputTokens).toBe(13_000);
    expect(s.printed.join('\n')).toContain('nothing was cleared');
  });

  test('an empty conversation is reset without saving a copy', async () => {
    const s = setup();
    s.conversation.resetAll();
    await s.registry.execute('clear', [], s.ctx);
    expect(s.toasts).toHaveLength(0);
    expect(s.sessionManager.list().length).toBe(0);
  });
});
