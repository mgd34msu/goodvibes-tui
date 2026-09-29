/**
 * session-resume-core.test.ts, the canonical resume routine both resume
 * seams (session-workflow.ts's /session resume and bootstrap-hook-bridge.ts's
 * session-browser resume) now call.
 *
 * Covers the four divergences the audit found between the two seams (now
 * impossible by construction, since both call this one function):
 *   1. restoreTurnAnchors is always called.
 *   2. conversation.resetAll() always runs before fromJSON().
 *   3. The selectModel reselection fallback (raw id on failure) is honored
 *      when provided, and skipped cleanly when omitted.
 *   4. A session saved while the TUI still had side panes carries
 *      returnContext.openPanels; it loads, and nothing is reopened.
 *
 * Also proves parity: two independent "seam-shaped" calls against the same
 * saved session produce the identical outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { ConversationManager } from '../../core/conversation.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resumeSessionCore } from '../../core/session-resume-core.ts';
import { clearTurnAnchors, getTurnAnchors, persistTurnAnchors, recordTurnAnchor } from '@pellux/goodvibes-sdk/platform/rewind';
import { makeTestSurface } from '../helpers/session-surface.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeProjectTempDir('gv-session-resume-core');
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function makeRuntime(sessionId = 'previous-session') {
  return { sessionId, model: 'old-model', provider: 'old-provider' };
}

describe('resumeSessionCore', () => {
  test('resets and restores the conversation from the saved session, not appending to whatever was already live', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-a', [{ role: 'user', content: 'saved message' }], { title: 'Saved', model: 'm', provider: 'p', timestamp: Date.now() });

    const conversation = new ConversationManager(() => 80);
    // Pre-populate with unrelated live content the resume must fully replace.
    conversation.fromJSON({ messages: [{ role: 'user', content: 'stale live message 1' }, { role: 'assistant', content: 'stale live message 2' }] as never });
    expect(conversation.getMessageCount()).toBe(2);

    const outcome = await resumeSessionCore('sess-a', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.resumedMessageCount).toBe(1);
    expect(conversation.getMessageCount()).toBe(1);
  });

  test('restores this session\'s persisted rewind anchors (restoreTurnAnchors is always called)', async () => {
    const sessionId = 'sess-anchors';
    clearTurnAnchors(sessionId);
    // Seed a sidecar the way a prior run would have (recordTurnAnchor + persistTurnAnchors).
    recordTurnAnchor(sessionId, { turnId: 't1', label: 'did a thing', messageCount: 1, at: Date.now() });
    persistTurnAnchors(sessionId, makeTestSurface(tmpDir));
    clearTurnAnchors(sessionId); // simulate a fresh process with an empty in-memory registry

    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save(sessionId, [{ role: 'user', content: 'hi' }], { title: 'T', model: 'm', provider: 'p', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore(sessionId, {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.restoredAnchorCount).toBe(1);
    expect(getTurnAnchors(sessionId)).toHaveLength(1);
  });

  test('with selectModel provided: reselects through the live provider registry', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-model', [], { title: 'T', model: 'saved-model-id', provider: 'saved-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    const outcome = await resumeSessionCore('sess-model', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
      selectModel: async (model) => ({ registryKey: `resolved:${model}`, providerId: 'resolved-provider' }),
    });

    expect(runtime.model).toBe('resolved:saved-model-id');
    // Pre-existing quirk carried over verbatim from the original
    // session-workflow.ts implementation: the reselected provider is
    // immediately overwritten by the raw saved meta.provider afterward
    // (`if (meta.provider) runtime.provider = meta.provider`, unconditional).
    // Not introduced or changed by this unification, out of this item's scope.
    expect(runtime.provider).toBe('saved-provider');
    expect(outcome.meta.model).toBe('saved-model-id');
  });

  test('with selectModel provided but it throws: falls back to the raw saved model id', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-model-gone', [], { title: 'T', model: 'no-longer-installed', provider: 'saved-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    await resumeSessionCore('sess-model-gone', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
      selectModel: async () => { throw new Error('model not found locally'); },
    });

    expect(runtime.model).toBe('no-longer-installed');
  });

  test('without selectModel: sets the model straight from the saved meta (the behavior when no provider API is wired)', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-direct-model', [], { title: 'T', model: 'direct-model-id', provider: 'direct-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    await resumeSessionCore('sess-direct-model', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
    });

    expect(runtime.model).toBe('direct-model-id');
    expect(runtime.provider).toBe('direct-provider');
  });

  test('calls hydrateSessionUsage exactly once when provided', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-hydrate', [], { title: 'T', model: 'm', provider: 'p', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    let hydrateCalls = 0;

    await resumeSessionCore('sess-hydrate', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
      hydrateSessionUsage: () => { hydrateCalls++; },
    });

    expect(hydrateCalls).toBe(1);
  });

  test('a session saved with returnContext.openPanels (from when the TUI had side panes) loads; the field is ignored', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-panels', [{ role: 'user', content: 'from the pane era' }], {
      title: 'T', model: 'm', provider: 'p', timestamp: Date.now(),
      returnContext: {
        activityLabel: 'idle', statusLabel: 'idle', pendingApprovals: 0, toolCallCount: 0,
        toolResultCount: 0, assistantTurnCount: 0, userTurnCount: 0, lines: [],
        openPanels: ['sessions', 'git', 'fleet', 'tokens'],
      },
    });
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore('sess-panels', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
    });

    expect(outcome.resumedMessageCount).toBe(1);
    expect(outcome.meta.returnContext?.openPanels).toEqual(['sessions', 'git', 'fleet', 'tokens']);
    expect(Object.keys(outcome)).not.toContain('panels');
  });
});

describe('parity: both resume seams reach an identical outcome for the same saved session', () => {
  test('a session-workflow-shaped call and a bootstrap-hook-bridge-shaped call produce the same restoredAnchorCount and resumedMessageCount', async () => {
    const sessionId = 'sess-parity';
    clearTurnAnchors(sessionId);
    recordTurnAnchor(sessionId, { turnId: 't1', label: 'parity turn', messageCount: 2, at: Date.now() });
    persistTurnAnchors(sessionId, makeTestSurface(tmpDir));
    clearTurnAnchors(sessionId);

    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save(sessionId, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], {
      title: 'Parity', model: 'shared-model', provider: 'shared-provider', timestamp: Date.now(),
      returnContext: {
        activityLabel: 'idle', statusLabel: 'idle', pendingApprovals: 0, toolCallCount: 0,
        toolResultCount: 0, assistantTurnCount: 0, userTurnCount: 0, lines: [],
        openPanels: ['git'],
      },
    });

    // Seam 1 shape: session-workflow.ts (with a selectModel reselection fn wired).
    clearTurnAnchors(sessionId); // each call starts from a fresh in-memory registry, mirroring separate processes
    const conversationA = new ConversationManager(() => 80);
    const runtimeA = makeRuntime();
    const outcomeA = await resumeSessionCore(sessionId, {
      sessionManager: sm,
      conversation: conversationA,
      runtime: runtimeA,
      surface: makeTestSurface(tmpDir),
      selectModel: async (model) => ({ registryKey: model, providerId: 'shared-provider' }),
    });

    // Seam 2 shape: bootstrap-hook-bridge.ts (selectModel now ALSO wired, per
    // this fix, the very divergence this parity test guards against).
    clearTurnAnchors(sessionId);
    const conversationB = new ConversationManager(() => 80);
    const runtimeB = makeRuntime();
    const outcomeB = await resumeSessionCore(sessionId, {
      sessionManager: sm,
      conversation: conversationB,
      runtime: runtimeB,
      surface: makeTestSurface(tmpDir),
      selectModel: async (model) => ({ registryKey: model, providerId: 'shared-provider' }),
    });

    expect(outcomeA.restoredAnchorCount).toBe(outcomeB.restoredAnchorCount);
    expect(outcomeA.restoredAnchorCount).toBe(1);
    expect(outcomeA.resumedMessageCount).toBe(outcomeB.resumedMessageCount);
    expect(runtimeA.model).toBe(runtimeB.model);
    expect(runtimeA.provider).toBe(runtimeB.provider);
  });
});
