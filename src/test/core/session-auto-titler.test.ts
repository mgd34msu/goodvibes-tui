import { describe, expect, test } from 'bun:test';
import { createSessionAutoTitler, sanitizeTitle, type TitlerConversation } from '@/core/session-auto-titler.ts';
import type { ConfigManager } from '@/config/index.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

const cfg: Pick<ConfigManager, 'getRaw'> = { getRaw: () => ({} as ReturnType<ConfigManager['getRaw']>) };

function fakeConversation(overrides: Partial<{
  titleSource: 'system' | 'user';
  messages: ConversationMessageSnapshot[];
}> = {}): TitlerConversation & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    title: '',
    getTitleSource: () => overrides.titleSource ?? 'system',
    setSystemTitle: (v: string) => { applied.push(v); },
    getMessageSnapshot: () => overrides.messages ?? [{ role: 'user', content: 'help me refactor the auth module' }],
  };
}

const turns = { on: () => () => {} };

describe('sanitizeTitle', () => {
  test('takes first line, strips quotes and trailing punctuation', () => {
    expect(sanitizeTitle('"Refactor Auth Module."\nextra')).toBe('Refactor Auth Module');
  });
  test('returns null for empty', () => {
    expect(sanitizeTitle('   ')).toBeNull();
  });
  test('caps overly long titles', () => {
    expect(sanitizeTitle('word '.repeat(40))?.length).toBeLessThanOrEqual(60);
  });
});

describe('createSessionAutoTitler.maybeTitle', () => {
  test('does nothing when autoTitle is off', async () => {
    const convo = fakeConversation();
    const titler = createSessionAutoTitler({
      conversation: convo, model: { chat: async () => 'Nope' }, configManager: cfg, turns,
      readSettings: () => ({ autoTitle: false }),
    });
    await titler.maybeTitle();
    expect(convo.applied).toEqual([]);
  });

  test('titles an untitled session via the model when enabled', async () => {
    const convo = fakeConversation();
    let prompt = '';
    const titler = createSessionAutoTitler({
      conversation: convo,
      model: { chat: async (p) => { prompt = p; return 'Refactor Auth Module'; } },
      configManager: cfg, turns,
      readSettings: () => ({ autoTitle: true }),
    });
    await titler.maybeTitle();
    expect(convo.applied).toEqual(['Refactor Auth Module']);
    expect(prompt).toContain('auth module');
  });

  test('never overwrites a user-chosen title', async () => {
    const convo = fakeConversation({ titleSource: 'user' });
    const titler = createSessionAutoTitler({
      conversation: convo, model: { chat: async () => 'X' }, configManager: cfg, turns,
      readSettings: () => ({ autoTitle: true }),
    });
    await titler.maybeTitle();
    expect(convo.applied).toEqual([]);
  });

  test('runs at most once', async () => {
    const convo = fakeConversation();
    let calls = 0;
    const titler = createSessionAutoTitler({
      conversation: convo, model: { chat: async () => `T${++calls}` }, configManager: cfg, turns,
      readSettings: () => ({ autoTitle: true }),
    });
    await titler.maybeTitle();
    await titler.maybeTitle();
    expect(calls).toBe(1);
    expect(convo.applied).toEqual(['T1']);
  });

  test('stays silent when the model throws', async () => {
    const convo = fakeConversation();
    const titler = createSessionAutoTitler({
      conversation: convo, model: { chat: async () => { throw new Error('unavailable'); } }, configManager: cfg, turns,
      readSettings: () => ({ autoTitle: true }),
    });
    await titler.maybeTitle();
    expect(convo.applied).toEqual([]);
  });

  test('skips when there is no user message', async () => {
    const convo = fakeConversation({ messages: [{ role: 'system', content: 'sys' }] });
    const titler = createSessionAutoTitler({
      conversation: convo, model: { chat: async () => 'X' }, configManager: cfg, turns,
      readSettings: () => ({ autoTitle: true }),
    });
    await titler.maybeTitle();
    expect(convo.applied).toEqual([]);
  });
});
