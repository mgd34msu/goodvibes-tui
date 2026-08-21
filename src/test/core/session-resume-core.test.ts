/**
 * session-resume-core.test.ts, the canonical resume routine both resume
 * seams (session-workflow.ts's /session resume and bootstrap-hook-bridge.ts's
 * panel/session-browser resume) now call.
 *
 * Covers the four divergences the audit found between the two seams (now
 * impossible by construction, since both call this one function):
 *   1. restoreTurnAnchors is always called.
 *   2. conversation.resetAll() always runs before fromJSON().
 *   3. The selectModel reselection fallback (raw id on failure) is honored
 *      when provided, and skipped cleanly when omitted.
 *   4. Panel reopen always skips MIGRATE-TO-MODAL ids, honestly reporting
 *      them separately from genuinely reopened panels, plus the new
 *      reopen-cap overflow report (item 7).
 *
 * Also proves parity: two independent "seam-shaped" calls against the same
 * saved session produce the identical outcome.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { ConversationManager } from '../../core/conversation.ts';
import { PanelManager } from '../../panels/panel-manager.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resumeSessionCore, reopenPanelsWithModalSkip, DEFAULT_PANEL_REOPEN_LIMIT } from '../../core/session-resume-core.ts';
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

function makePanelManagerWithGit(): PanelManager {
  const pm = new PanelManager();
  pm.registerType({
    id: 'git', name: 'Git', icon: 'G', category: 'development', description: '',
    factory: () => ({
      id: 'git', name: 'Git', icon: 'G', category: 'development',
      onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {}, render: () => [],
      isTransient: false, isPinned: false, needsRender: false,
      invalidate: () => {}, markRendered: () => {},
    }),
  });
  return pm;
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
      panelManager: makePanelManagerWithGit(),
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
      panelManager: makePanelManagerWithGit(),
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
      panelManager: makePanelManagerWithGit(),
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
      panelManager: makePanelManagerWithGit(),
      selectModel: async () => { throw new Error('model not found locally'); },
    });

    expect(runtime.model).toBe('no-longer-installed');
  });

  test('without selectModel: sets the model straight from the saved meta (matches the panel seam\'s pre-existing behavior when no provider API is wired)', async () => {
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-direct-model', [], { title: 'T', model: 'direct-model-id', provider: 'direct-provider', timestamp: Date.now() });
    const conversation = new ConversationManager(() => 80);
    const runtime = makeRuntime();

    await resumeSessionCore('sess-direct-model', {
      sessionManager: sm,
      conversation,
      runtime,
      surface: makeTestSurface(tmpDir),
      panelManager: makePanelManagerWithGit(),
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
      panelManager: makePanelManagerWithGit(),
      hydrateSessionUsage: () => { hydrateCalls++; },
    });

    expect(hydrateCalls).toBe(1);
  });

  test('reopens saved panels, skipping a MIGRATE-TO-MODAL id and honestly noting it (never pops a modal mid-resume)', async () => {
    const pm = makePanelManagerWithGit();
    pm.registerModalRedirect('sessions', 'sessionPicker');
    const modalOpens: string[] = [];
    pm.setOpenModalCallback((name) => modalOpens.push(name));

    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-panels', [], {
      title: 'T', model: 'm', provider: 'p', timestamp: Date.now(),
      returnContext: {
        activityLabel: 'idle', statusLabel: 'idle', pendingApprovals: 0, toolCallCount: 0,
        toolResultCount: 0, assistantTurnCount: 0, userTurnCount: 0, lines: [],
        openPanels: ['sessions', 'git'],
      },
    });
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore('sess-panels', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
      panelManager: pm,
    });

    expect(outcome.panels.reopened).toEqual(['git']);
    expect(outcome.panels.movedToModal).toEqual(['sessions']);
    expect(modalOpens).toEqual([]); // never pops the modal mid-resume
    expect(pm.getAllOpen().map((p) => p.id)).toEqual(['git']);
  });

  test('caps panel reopen at the deliberate limit and reports the overflow honestly (item 7)', async () => {
    const pm = new PanelManager();
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    ids.forEach((id, i) => {
      const icon = String.fromCharCode(97 + i); // unique per-panel icon: 'a', 'b', 'c', ...
      pm.registerType({
        id, name: id, icon, category: 'development', description: '',
        factory: () => ({
          id, name: id, icon, category: 'development',
          onActivate: () => {}, onDeactivate: () => {}, onDestroy: () => {}, render: () => [],
          isTransient: false, isPinned: false, needsRender: false,
          invalidate: () => {}, markRendered: () => {},
        }),
      });
    });
    const sm = new SessionManager(tmpDir, { surface: makeTestSurface(tmpDir) });
    sm.save('sess-overflow', [], {
      title: 'T', model: 'm', provider: 'p', timestamp: Date.now(),
      returnContext: {
        activityLabel: 'idle', statusLabel: 'idle', pendingApprovals: 0, toolCallCount: 0,
        toolResultCount: 0, assistantTurnCount: 0, userTurnCount: 0, lines: [],
        openPanels: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
      },
    });
    const conversation = new ConversationManager(() => 80);

    const outcome = await resumeSessionCore('sess-overflow', {
      sessionManager: sm,
      conversation,
      runtime: makeRuntime(),
      surface: makeTestSurface(tmpDir),
      panelManager: pm,
    });

    expect(outcome.panels.reopened).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(outcome.panels.notReopened).toEqual(['p5', 'p6']);
    expect(DEFAULT_PANEL_REOPEN_LIMIT).toBe(4);
  });
});

describe('reopenPanelsWithModalSkip', () => {
  test('no saved panels at all is a no-op (no crash on an undefined/empty list)', () => {
    const pm = makePanelManagerWithGit();
    expect(reopenPanelsWithModalSkip(pm, undefined, 4)).toEqual({ reopened: [], movedToModal: [], notReopened: [] });
    expect(reopenPanelsWithModalSkip(pm, [], 4)).toEqual({ reopened: [], movedToModal: [], notReopened: [] });
  });

  test('an unknown/unavailable panel id is silently skipped, never thrown', () => {
    const pm = makePanelManagerWithGit();
    const result = reopenPanelsWithModalSkip(pm, ['git', 'no-such-panel'], 4);
    expect(result.reopened).toEqual(['git']);
    expect(result.notReopened).toEqual([]);
  });
});

describe('parity: both resume seams reach an identical outcome for the same saved session', () => {
  test('a session-workflow-shaped call and a bootstrap-hook-bridge-shaped call produce the same restoredAnchorCount, resumedMessageCount, and panel outcome', async () => {
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
      panelManager: makePanelManagerWithGit(),
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
      panelManager: makePanelManagerWithGit(),
      selectModel: async (model) => ({ registryKey: model, providerId: 'shared-provider' }),
    });

    expect(outcomeA.restoredAnchorCount).toBe(outcomeB.restoredAnchorCount);
    expect(outcomeA.restoredAnchorCount).toBe(1);
    expect(outcomeA.resumedMessageCount).toBe(outcomeB.resumedMessageCount);
    expect(outcomeA.panels).toEqual(outcomeB.panels);
    expect(runtimeA.model).toBe(runtimeB.model);
    expect(runtimeA.provider).toBe(runtimeB.provider);
  });
});
