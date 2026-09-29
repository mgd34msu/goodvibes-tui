/**
 * A turn header says "working" only while the turn works, and once it ends it
 * says how it ended: nothing extra when it completed, "failed" or
 * "cancelled" when not, live and after a resume.
 *
 * Live run on 14d4e369: the answered turn's header kept "working · 1 tool ·
 * 9.3s" after the turn finished. The transcript was rebuilt only when marked
 * dirty, and the live repaint tick marks it dirty only when its 150 ms frame
 * moved on; the render that followed the turn's end fell in the same frame, so
 * nothing ever rebuilt the header.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { ConversationManager } from '../../core/conversation.ts';
import { buildTurnModel, transcriptUnits, type TurnModel } from '../../core/work-tree-model.ts';
import { userMessageFingerprint, WorkTreeTimingStore, type TurnTiming, type WorkTreeSources } from '../../core/work-tree-sources.ts';
import { loadWorkTreeTurnOutcomes, saveWorkTreeFolds } from '../../core/work-tree-fold-store.ts';
import { restoreWorkTreeFolds, wireWorkTree } from '../../core/work-tree-wiring.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type Message = ConversationMessageSnapshot;
const user = (content: string, extra: Partial<Extract<Message, { role: 'user' }>> = {}): Message => ({ role: 'user', content, ...extra });
const asst = (content: string): Message => ({ role: 'assistant', content, model: 'm1' });

function turn(messages: Message[], sources: WorkTreeSources): TurnModel {
  const unit = transcriptUnits(messages).filter((u) => u.kind === 'turn').pop();
  if (!unit || unit.kind !== 'turn') throw new Error('no turn');
  return buildTurnModel({ messages, offset: 0, unit, sources: { now: () => 2000, ...sources }, collapse: new Map(), streamingIndex: -1 });
}

describe('turn header states', () => {
  const messages = [user('q'), asst('answer')];
  const timing = (extra: Partial<TurnTiming>): TurnTiming => ({ startedAt: 1000, endedAt: 1500, fingerprint: userMessageFingerprint(messages[0]), ...extra });

  test('working while active; a completed turn adds nothing and shows its time', () => {
    expect(turn(messages, { turnActive: () => true, turnTiming: () => ({ startedAt: 1000 }) }).headerText).toBe('m1 · working · 1.0s');
    expect(turn(messages, { turnActive: () => false, turnTiming: () => timing({ outcome: 'completed' }) }).headerText).toBe('m1 · 0.5s');
  });

  test('a failed or cancelled turn says so', () => {
    expect(turn(messages, { turnActive: () => false, turnTiming: () => timing({ outcome: 'failed' }) }).headerText).toBe('m1 · failed · 0.5s');
    expect(turn(messages, { turnActive: () => false, turnTiming: () => timing({ outcome: 'cancelled' }) }).headerText).toBe('m1 · cancelled · 0.5s');
  });

  test('a cancelled user message makes its turn cancelled with no live record', () => {
    expect(turn([user('q', { cancelled: true }), asst('partial')], { turnActive: () => false }).headerText).toBe('m1 · cancelled');
  });

  test('a saved ending applies only to the message it was saved for', () => {
    const fp = userMessageFingerprint(messages[0])!;
    expect(turn(messages, { turnActive: () => false, turnOutcome: () => ({ outcome: 'failed', fingerprint: fp }) }).headerText).toBe('m1 · failed');
    expect(turn(messages, { turnActive: () => false, turnOutcome: () => ({ outcome: 'failed', fingerprint: '1:x' }) }).headerText).toBe('m1');
  });

  test('a timing record made for a different message is ignored', () => {
    expect(turn(messages, { turnActive: () => false, turnTiming: () => ({ startedAt: 0, endedAt: 900, outcome: 'failed', fingerprint: '5:other' }) }).headerText).toBe('m1');
  });
});

describe('the transcript rebuilds when the turn stops working', () => {
  test('without any other change, the header drops "working" on the next display', () => {
    const cm = new ConversationManager(() => 100);
    let active = true;
    cm.setWorkTreeSources({ turnActive: () => active });
    cm.addUserMessage('q');
    cm.addAssistantMessage('answer', { model: 'm1' });
    const text = (): string => cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join('')).join('\n');
    expect(text()).toContain('working');
    active = false;
    // No new message, no dirty mark, the same width and the same live frame: only the activity changed.
    expect(text()).not.toContain('working');
  });
});

describe('turn endings are recorded, kept per session and restored', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test('the timing store closes the open turn with its outcome and fingerprint', () => {
    const store = new WorkTreeTimingStore();
    store.turnStarted(4, 100, '1:q');
    const ended = store.turnEnded(250, 'failed');
    expect(ended).toEqual({ index: 4, timing: { startedAt: 100, endedAt: 250, outcome: 'failed', fingerprint: '1:q' } });
    expect(store.turnEnded(300, 'completed')).toBeUndefined();
  });

  test('saved failed/cancelled endings round-trip through the sidecar; malformed ones are dropped', () => {
    const dir = makeProjectTempDir('gv-outcomes');
    dirs.push(dir);
    saveWorkTreeFolds(dir, 'user-abc', [['turn_1', true]], [{ index: 0, fingerprint: '1:q', outcome: 'failed' }]);
    expect(loadWorkTreeTurnOutcomes(dir, 'user-abc')).toEqual([{ index: 0, fingerprint: '1:q', outcome: 'failed' }]);
    writeFileSync(join(dir, 'user-bad.work-tree.json'), JSON.stringify({ version: 1, folds: {}, turns: [{ index: -1, fingerprint: 'x', outcome: 'failed' }, { index: 2, fingerprint: 'y', outcome: 'exploded' }, { index: 3, fingerprint: 'z', outcome: 'cancelled' }] }));
    expect(loadWorkTreeTurnOutcomes(dir, 'user-bad')).toEqual([{ index: 3, fingerprint: 'z', outcome: 'cancelled' }]);
  });

  test('a resumed session shows its failed turn as failed', () => {
    const dir = makeProjectTempDir('gv-outcomes');
    dirs.push(dir);
    const cm = new ConversationManager(() => 100);
    cm.fromJSON({ messages: [user('q'), asst('partial')] });
    saveWorkTreeFolds(dir, 'user-abc', [], [{ index: 0, fingerprint: userMessageFingerprint(user('q'))!, outcome: 'failed' }]);
    restoreWorkTreeFolds(cm, dir, 'user-abc');
    cm.setWorkTreeSources({ turnActive: () => false, turnOutcome: (i) => cm.workTree.turnOutcome(i) });
    const text = cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join('')).join('\n');
    expect(text).toContain('m1 · failed');
  });

  test('a reset forgets the old transcript\'s endings and tells listeners', () => {
    const cm = new ConversationManager(() => 100);
    let resets = 0;
    cm.workTree.onReset(() => { resets++; });
    expect(cm.workTree.recordTurnOutcome({ index: 0, fingerprint: '1:q', outcome: 'cancelled' })).toBe(true);
    cm.resetAll();
    expect(cm.workTree.turnOutcome(0)).toBeUndefined();
    expect(resets).toBe(1);
  });

  test('a completed turn replaces an old failed record at the same index', () => {
    const cm = new ConversationManager(() => 100);
    cm.workTree.recordTurnOutcome({ index: 2, fingerprint: '1:q', outcome: 'failed' });
    expect(cm.workTree.recordTurnOutcome({ index: 2, fingerprint: '1:q', outcome: 'completed' })).toBe(true);
    expect(cm.workTree.turnOutcome(2)).toBeUndefined();
    expect(cm.workTree.recordTurnOutcome({ index: 5, fingerprint: '1:q', outcome: 'completed' })).toBe(false);
  });
});

describe('turn-end events drive the header and the sidecar', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function bus() {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    return {
      on: (type: string, fn: (e: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); return () => {}; },
      emit: (type: string, e: unknown = {}) => { for (const fn of listeners.get(type) ?? []) fn(e); },
    };
  }

  function wired(active: { value: boolean }) {
    const dir = makeProjectTempDir('gv-wiring');
    dirs.push(dir);
    const turns = bus();
    const tools = bus();
    const cm = new ConversationManager(() => 100);
    wireWorkTree({
      conversation: cm,
      events: { turns, tools } as unknown as Parameters<typeof wireWorkTree>[0]['events'],
      agentManager: { getStatus: () => null, getConversationSnapshot: () => [] } as unknown as Parameters<typeof wireWorkTree>[0]['agentManager'],
      listChains: () => [],
      fleetNodes: () => [],
      pendingCallId: () => undefined,
      turnActive: () => active.value,
      sessionsDir: dir,
      sessionId: () => 'user-live',
      requestRender: () => {},
    });
    const text = (): string => cm.getDisplayBlocks().map((l) => l.map((c) => c.char || ' ').join('')).join('\n');
    return { cm, turns, dir, text };
  }

  test('TURN_ERROR leaves a "failed" header and a saved record; TURN_COMPLETED leaves none', () => {
    const active = { value: true };
    const { cm, turns, dir, text } = wired(active);
    cm.addUserMessage('first');
    turns.emit('TURN_SUBMITTED');
    cm.addAssistantMessage('partial', { model: 'm1' });
    active.value = false;
    turns.emit('TURN_ERROR', { error: 'boom' });
    expect(text()).toContain('m1 · failed');
    expect(loadWorkTreeTurnOutcomes(dir, 'user-live')).toEqual([{ index: 0, fingerprint: userMessageFingerprint(user('first'))!, outcome: 'failed' }]);

    cm.addUserMessage('second');
    active.value = true;
    turns.emit('TURN_SUBMITTED');
    cm.addAssistantMessage('done', { model: 'm1' });
    active.value = false;
    turns.emit('TURN_COMPLETED', { stopReason: 'completed' });
    const shown = text();
    expect(shown).not.toContain('working');
    expect(shown.match(/failed/g)?.length).toBe(1);
  });

  test('TURN_CANCEL says cancelled; an empty response counts as failed', () => {
    const active = { value: true };
    const { cm, turns, text } = wired(active);
    cm.addUserMessage('a');
    turns.emit('TURN_SUBMITTED');
    cm.addAssistantMessage('part', { model: 'm1' });
    active.value = false;
    turns.emit('TURN_CANCEL', { stopReason: 'cancelled' });
    expect(text()).toContain('m1 · cancelled');
    cm.addUserMessage('b');
    active.value = true;
    turns.emit('TURN_SUBMITTED');
    cm.addAssistantMessage('x', { model: 'm2' });
    active.value = false;
    turns.emit('TURN_COMPLETED', { stopReason: 'empty_response' });
    expect(text()).toContain('m2 · failed');
  });
});
