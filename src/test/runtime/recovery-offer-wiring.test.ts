/**
 * recovery-offer-wiring.test.ts — the startup recovery offer against real
 * objects, not stubs of its own edges.
 *
 * recovery-prompt.test.ts covers the flow with an injected `applySnapshot`.
 * This file covers what that injection actually does in the app: a real
 * ConversationManager, a real SessionManager, the real surface, and the real
 * pointer writer — because a fix can be correct in isolation and still ship
 * inert if nothing invokes it. The sibling repo's pointer arity fix did
 * exactly that, so the pointer assertion here reads the file off disk and
 * parses it rather than trusting a spy.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { readLastSessionPointer, writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { buildRecoveryOfferWiring } from '../../runtime/recovery-offer-wiring.ts';
import { offerRecoverySnapshot, type SelectionOpener,  resetAnsweredRecoveryOffersForTest } from '../../runtime/recovery-prompt.ts';
import { bindWriteLastSessionPointerToSurface } from '../../runtime/session-pointer-surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;
let surface: SessionSurface;

beforeEach(() => {
  resetAnsweredRecoveryOffersForTest();
  tmpDir = makeProjectTempDir('gv-recovery-wiring');
  surface = makeTestSurface(tmpDir);
});
afterEach(() => { if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }); });

function answerWith(...ids: Array<string | null>): SelectionOpener {
  let i = 0;
  return (_title, _items, _opts, cb) => {
    const id = ids[i] ?? null;
    i += 1;
    cb(id === null ? null : { item: { id, label: id }, action: 'select' });
  };
}

function setup(sessionId: string, messages: Array<Record<string, unknown>>) {
  writeRecoveryFile(
    { messages: messages as never, title: 'Crashed mid-refactor', titleSource: 'auto', timestamp: Date.now() - 60_000 },
    sessionId,
    'Crashed mid-refactor',
    { surface },
  );
  const conversation = new ConversationManager(() => 80);
  const runtime = { sessionId: 'fresh-boot-session', model: 'test-model', provider: 'test-provider' };
  const receipts: string[] = [];
  let hydrated = 0;

  const deps = buildRecoveryOfferWiring({
    surface,
    sessionManager: new SessionManager(tmpDir, { surface }),
    runtime,
    conversation,
    commandContext: {
      openSelection: undefined,
      session: { hydrateSessionUsage: () => { hydrated += 1; } },
    } as never,
    // The real bound closure, exactly as bootstrap.ts builds it.
    writeLastSessionPointer: bindWriteLastSessionPointerToSurface(surface),
    receipt: (line) => receipts.push(line),
    render: () => {},
  });

  return { deps, conversation, runtime, receipts, hydrated: () => hydrated };
}

/** Point the wiring's lazily-read opener at a scripted operator. */
function withOperator(deps: ReturnType<typeof setup>['deps'], opener: SelectionOpener) {
  return { ...deps, openSelection: opener };
}

describe('accepting the offer restores the real conversation', () => {
  test('the recovered messages land in the live conversation', async () => {
    const { deps, conversation } = setup('crashed-1', [
      { role: 'user', content: 'rename the module' },
      { role: 'assistant', content: 'starting' },
      { role: 'user', content: 'and update the imports' },
    ]);

    expect(await offerRecoverySnapshot(withOperator(deps, answerWith('resume')))).toBe('resumed');
    expect(conversation.getMessageCount()).toBe(3);
  });

  test('the runtime adopts the recovered session id, so later turns write back to it', async () => {
    const { deps, runtime } = setup('crashed-2', [{ role: 'user', content: 'hi' }]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));
    expect(runtime.sessionId).toBe('crashed-2');
  });

  test('the last-session pointer genuinely lands on disk — read raw, not through a spy', async () => {
    const { deps } = setup('crashed-3', [{ role: 'user', content: 'hi' }]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));

    // 1. The file exists exactly where the surface says it should.
    expect(existsSync(surface.lastSessionPointer)).toBe(true);
    // 2. Its contents name the recovered session.
    const raw = JSON.parse(readFileSync(surface.lastSessionPointer, 'utf-8')) as { sessionId?: string };
    expect(raw.sessionId).toBe('crashed-3');
    // 3. A relaunched process's own surface reads it back.
    expect(readLastSessionPointer({ surface: makeTestSurface(tmpDir) })).toBe('crashed-3');
  });

  test('the recovered session is written into the session store, so /session resume reaches it later', async () => {
    const { deps } = setup('crashed-4', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'there' }]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));

    const relaunchManager = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    const listed = relaunchManager.list().map((s) => s.name);
    expect(listed).toContain('crashed-4');
  });

  test('the session store entry is stamped as a user save — the operator asked for this recovery', async () => {
    const { deps } = setup('crashed-5', [{ role: 'user', content: 'hi' }]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));

    const meta = new SessionManager(tmpDir, { surface }).getMeta('crashed-5');
    expect(meta?.saveSource).toBe('user');
  });

  test('the footer token counters are rehydrated from the restored history', async () => {
    const { deps, hydrated } = setup('crashed-6', [{ role: 'user', content: 'hi' }]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));
    expect(hydrated()).toBe(1);
  });

  test('one honest receipt naming the real message count', async () => {
    const { deps, receipts } = setup('crashed-7', [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);

    await offerRecoverySnapshot(withOperator(deps, answerWith('resume')));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('2 message(s)');
    expect(receipts[0]).toContain('crashed-7');
  });
});

describe('declining leaves the live session exactly as it booted', () => {
  test('Not now + Keep: no conversation state, no session id change, no pointer written', async () => {
    const { deps, conversation, runtime } = setup('crashed-8', [{ role: 'user', content: 'hi' }]);

    expect(await offerRecoverySnapshot(withOperator(deps, answerWith('not-now', 'keep')))).toBe('kept');

    expect(conversation.getMessageCount()).toBe(0);
    expect(runtime.sessionId).toBe('fresh-boot-session');
    expect(existsSync(surface.lastSessionPointer)).toBe(false);
    expect(existsSync(surface.recoveryFile('crashed-8'))).toBe(true);
  });

  test('Not now + Remove: the snapshot goes, but nothing was ever loaded into the conversation', async () => {
    const { deps, conversation, runtime } = setup('crashed-9', [{ role: 'user', content: 'hi' }]);

    expect(await offerRecoverySnapshot(withOperator(deps, answerWith('not-now', 'remove')))).toBe('removed');

    expect(conversation.getMessageCount()).toBe(0);
    expect(runtime.sessionId).toBe('fresh-boot-session');
    expect(existsSync(surface.recoveryFile('crashed-9'))).toBe(false);
  });
});
