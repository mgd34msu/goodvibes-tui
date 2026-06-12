/**
 * UX Anti-Regression: Resume/Recovery With Active State (v3 §18.5)
 *
 * Verifies that recovering a session with active panels and overlays
 * restores correct state — panels reopen, overlays remain in their
 * pre-suspend visibility state, and session metadata is reconciled.
 *
 * Also covers the blocking-input recovery prompt contract:
 * - Stray keys must not delete the recovery file
 * - Explicit discard (Esc/Ctrl+C) deletes the file
 * - Ctrl+R restores messages, title, titleSource and reopens panels
 * - File is deleted only after a successful restore
 *
 * All tests use pure state manipulation — no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { handleBlockingShellInput } from '../../shell/blocking-input.ts';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import {
  selectPanels,
  selectSession,
  selectActivePanels,
  selectAnyOverlayVisible,
} from '../../runtime/store/selectors/index.ts';
import type { PanelDomainState, PanelId } from '../../runtime/store/domains/panels.ts';
import type { SessionDomainState } from '@/runtime/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

/** Build a panel state map with given panels open/focused. */
function makePanelState(openPanelIds: PanelId[], focusedPanelId: PanelId): PanelDomainState {
  const base = selectPanels(createInitialRuntimeState());
  const panelMap = new Map(base.panels);

  for (const [id, panel] of panelMap) {
    const shouldBeOpen = openPanelIds.includes(id);
    const shouldBeFocused = id === focusedPanelId;
    panelMap.set(id, {
      ...panel,
      open: shouldBeOpen,
      focused: shouldBeFocused,
      lastActivatedAt: shouldBeOpen ? TEST_TIMESTAMP - 1000 : undefined,
    });
  }

  return {
    ...base,
    panels: panelMap,
    focusedPanelId,
    revision: base.revision + 1,
    lastUpdatedAt: TEST_TIMESTAMP,
    source: 'resume-test',
  };
}

/** Simulate a suspended state — panels closed, session status suspended. */
function buildSuspendedState(activeState: RuntimeState): RuntimeState {
  const activePanelState = selectPanels(activeState);
  const closedPanels = new Map(activePanelState.panels);
  for (const [id, panel] of closedPanels) {
    closedPanels.set(id, { ...panel, open: false, focused: false });
  }

  return {
    ...activeState,
    panels: {
      ...activePanelState,
      panels: closedPanels,
      revision: activePanelState.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'suspend',
    } as unknown as Record<string, unknown>,
    session: {
      ...activeState.session,
      status: 'suspended',
      revision: activeState.session.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'suspend',
    },
  };
}

/** Simulate session recovery: restore panel state and update session metadata. */
function applyResume(
  suspendedState: RuntimeState,
  snapshot: {
    panels: PanelDomainState;
    session?: Partial<SessionDomainState>;
  },
): RuntimeState {
  return {
    ...suspendedState,
    panels: {
      ...snapshot.panels,
      revision: selectPanels(suspendedState).revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'resume',
    } as unknown as Record<string, unknown>,
    session: {
      ...suspendedState.session,
      ...(snapshot.session ?? {}),
      status: 'active',
      isResumed: true,
      recoveryState: 'ready',
      revision: suspendedState.session.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'resume',
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ux:resume-recovery — restore session with active panels and overlays', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('panel state restoration', () => {
    test('open panels are restored from snapshot after resume', () => {
      const panels = selectPanels(createInitialRuntimeState());
      const panelIds = [...panels.panels.keys()] as PanelId[];

      // Pick 2 panels to be open
      const openIds = panelIds.slice(0, 2);
      const focusId = openIds[0]!;

      const activePanel = makePanelState(openIds, focusId);

      // Suspend (close all)
      const suspended = buildSuspendedState({ ...state, panels: activePanel as unknown as Record<string, unknown> });
      const allClosed = [...selectPanels(suspended).panels.values()].every((p) => !p.open);
      expect(allClosed).toBe(true);

      // Resume
      const resumed = applyResume(suspended, { panels: activePanel });

      // Assert panels reopened
      for (const id of openIds) {
        const panel = selectPanels(resumed).panels.get(id);
        expect(panel?.open).toBe(true);
      }
    });

    test('focused panel is restored correctly after resume', () => {
      const panels = selectPanels(createInitialRuntimeState());
      const panelIds = [...panels.panels.keys()] as PanelId[];
      const focusId = panelIds[1]!;
      const openIds = panelIds.slice(0, 3);

      const activePanel = makePanelState(openIds, focusId);
      const suspended = buildSuspendedState({ ...state, panels: activePanel as unknown as Record<string, unknown> });
      const resumed = applyResume(suspended, { panels: activePanel });

      expect(selectPanels(resumed).focusedPanelId).toBe(focusId);
    });

    test('activePanels selector returns correct panels after resume', () => {
      const panels = selectPanels(createInitialRuntimeState());
      const panelIds = [...panels.panels.keys()] as PanelId[];
      const openIds = panelIds.slice(0, 3);

      const activePanel = makePanelState(openIds, openIds[0]!);
      const suspended = buildSuspendedState({ ...state, panels: activePanel as unknown as Record<string, unknown> });
      const resumed = applyResume(suspended, { panels: activePanel });

      const activePanels = selectActivePanels(resumed);
      const openPanelIds = activePanels.map((p) => p.id);
      for (const id of openIds) {
        expect(openPanelIds).toContain(id);
      }
    });

    test('panels not in open list remain closed after resume', () => {
      const panels = selectPanels(createInitialRuntimeState());
      const panelIds = [...panels.panels.keys()] as PanelId[];

      // Open only first 2, the rest should be closed
      const openIds = panelIds.slice(0, 2);
      const closedIds = panelIds.slice(2);

      const activePanel = makePanelState(openIds, openIds[0]!);
      const suspended = buildSuspendedState({ ...state, panels: activePanel as unknown as Record<string, unknown> });
      const resumed = applyResume(suspended, { panels: activePanel });

      for (const id of closedIds) {
        const panel = selectPanels(resumed).panels.get(id);
        expect(panel?.open).toBe(false);
      }
    });
  });

  describe('overlay state after resume', () => {
    test('no overlays are visible in initial resumed state', () => {
      expect(selectAnyOverlayVisible(state)).toBe(false);

      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended, { panels: selectPanels(state) });
      expect(selectAnyOverlayVisible(resumed)).toBe(false);
    });
  });

  describe('session metadata reconciliation', () => {
    test('session ID is preserved across resume', () => {
      const sessionId = state.session.id;
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended, { panels: selectPanels(state), session: { id: sessionId } });
      expect(selectSession(resumed).id).toBe(sessionId);
    });

    test('resume revision is greater than suspended revision', () => {
      const suspended = buildSuspendedState(state);
      const suspendedRev = selectPanels(suspended).revision;

      const resumed = applyResume(suspended, { panels: selectPanels(state) });
      expect(selectPanels(resumed).revision).toBeGreaterThan(suspendedRev);
    });

    test('source is set to resume after recovery', () => {
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended, { panels: selectPanels(state) });
      expect(selectPanels(resumed).source).toBe('resume');
      expect(selectSession(resumed).source).toBe('resume');
    });

    test('session status transitions to active after resume', () => {
      const suspended = buildSuspendedState(state);
      expect(selectSession(suspended).status).toBe('suspended');

      const resumed = applyResume(suspended, { panels: selectPanels(state) });
      expect(selectSession(resumed).status).toBe('active');
    });

    test('isResumed flag is set after recovery', () => {
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended, { panels: selectPanels(state) });
      expect(selectSession(resumed).isResumed).toBe(true);
    });

    test('multiple resume cycles produce correct final state', () => {
      const panels = selectPanels(createInitialRuntimeState());
      const panelIds = [...panels.panels.keys()] as PanelId[];
      const openIds = panelIds.slice(0, 2);
      const panelSnapshot = makePanelState(openIds, openIds[0]!);

      let current = state;
      for (let i = 0; i < 5; i++) {
        current = { ...current, panels: panelSnapshot as unknown as Record<string, unknown> };
        current = buildSuspendedState(current);
        current = applyResume(current, { panels: panelSnapshot });
      }

      // After 5 resume cycles, correct panels are open
      for (const id of openIds) {
        const panel = selectPanels(current).panels.get(id);
        expect(panel?.open).toBe(true);
      }
      expect(selectSession(current).isResumed).toBe(true);
      expect(selectSession(current).status).toBe('active');
    });
  });
});

// ── Blocking-input recovery prompt contract ────────────────────────────────────

/** Minimal stubs for handleBlockingShellInput in the context of recovery. */
function makeRecoveryHarness() {
  const fromJSONCalls: Array<{ messages: object[]; title?: string; titleSource?: string }> = [];
  const routerMessages: string[] = [];
  const reopenedWith: object[] = [];
  let deleteCount = 0;
  let renderCount = 0;

  const conversation = {
    fromJSON: (data: { messages: object[]; title?: string; titleSource?: string }) => {
      fromJSONCalls.push(data);
    },
  };
  const systemMessageRouter = { high: (m: string) => routerMessages.push(m) };
  const render = () => { renderCount++; };
  const deleteRecoveryFile = () => { deleteCount++; };
  const reopenPanels = (s: object) => { reopenedWith.push(s); };
  // Journal-replay stubs: /tmp path ensures no real journal exists, so replay is a no-op.
  const homeDirectory = '/tmp/test-home-recovery';
  const sessionId = 'test-recovery-session';
  const persistSnapshot = () => {};

  return { fromJSONCalls, routerMessages, reopenedWith, conversation, systemMessageRouter, render, deleteRecoveryFile, reopenPanels, homeDirectory, sessionId, persistSnapshot, get deleteCount() { return deleteCount; }, get renderCount() { return renderCount; } };
}

describe('ux:recovery-prompt — blocking-input handler contract', () => {
  test('stray key leaves recovery file intact and prompt active', () => {
    const h = makeRecoveryHarness();
    const snapshot = { messages: [{ role: 'user', content: 'hello' }] };

    const result = handleBlockingShellInput({
      data: 'x',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: h.conversation as never,
      systemMessageRouter: h.systemMessageRouter as never,
      render: h.render,
      loadRecoveryConversation: () => snapshot,
      deleteRecoveryFile: h.deleteRecoveryFile,
      reopenPanels: h.reopenPanels,
      homeDirectory: h.homeDirectory,
      sessionId: h.sessionId,
      persistSnapshot: h.persistSnapshot,
    });

    expect(result.recoveryPending).toBe(true);
    expect(result.handled).toBe(false);
    expect(h.deleteCount).toBe(0);
    expect(h.fromJSONCalls).toHaveLength(0);
    expect(h.reopenedWith).toHaveLength(0);
    expect(h.routerMessages).toContain('[Recovery] Ctrl+R to restore · Esc to discard');
  });

  test('Esc discards recovery: file deleted, prompt cleared, key absorbed', () => {
    const h = makeRecoveryHarness();

    const result = handleBlockingShellInput({
      data: '\x1b',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: h.conversation as never,
      systemMessageRouter: h.systemMessageRouter as never,
      render: h.render,
      loadRecoveryConversation: () => ({ messages: [] }),
      deleteRecoveryFile: h.deleteRecoveryFile,
      homeDirectory: h.homeDirectory,
      sessionId: h.sessionId,
      persistSnapshot: h.persistSnapshot,
    });

    expect(result.recoveryPending).toBe(false);
    expect(result.handled).toBe(true);
    expect(h.deleteCount).toBe(1);
    expect(h.fromJSONCalls).toHaveLength(0);
    expect(h.routerMessages).toContain('[Recovery] Discarded recovery data.');
  });

  test('Ctrl+C discards recovery same as Esc', () => {
    const h = makeRecoveryHarness();

    const result = handleBlockingShellInput({
      data: '\x03',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: h.conversation as never,
      systemMessageRouter: h.systemMessageRouter as never,
      render: h.render,
      loadRecoveryConversation: () => ({ messages: [] }),
      deleteRecoveryFile: h.deleteRecoveryFile,
      homeDirectory: h.homeDirectory,
      sessionId: h.sessionId,
      persistSnapshot: h.persistSnapshot,
    });

    expect(result.recoveryPending).toBe(false);
    expect(result.handled).toBe(true);
    expect(h.deleteCount).toBe(1);
  });

  test('Ctrl+R restores messages, title, titleSource and reopens panels; file deleted after success', () => {
    const h = makeRecoveryHarness();
    const snapshot = {
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      title: 'Recovered Work',
      titleSource: 'user' as const,
      returnContext: { openPanels: ['remote', 'approval'] },
    };

    const result = handleBlockingShellInput({
      data: '\x12',
      pendingPermission: null,
      recoveryPending: true,
      abortTurn: () => {},
      conversation: h.conversation as never,
      systemMessageRouter: h.systemMessageRouter as never,
      render: h.render,
      loadRecoveryConversation: () => snapshot,
      deleteRecoveryFile: h.deleteRecoveryFile,
      reopenPanels: h.reopenPanels,
      homeDirectory: h.homeDirectory,
      sessionId: h.sessionId,
      persistSnapshot: h.persistSnapshot,
    });

    // Result state
    expect(result.handled).toBe(true);
    expect(result.recoveryPending).toBe(false);

    // Messages restored
    expect(h.fromJSONCalls).toHaveLength(1);
    expect(h.fromJSONCalls[0]!.messages).toHaveLength(2);

    // Title and titleSource hydrated
    expect(h.fromJSONCalls[0]!.title).toBe('Recovered Work');
    expect(h.fromJSONCalls[0]!.titleSource).toBe('user');

    // Panels reopened via callback with the full snapshot
    expect(h.reopenedWith).toHaveLength(1);
    expect(h.reopenedWith[0]).toBe(snapshot);

    // File deleted exactly once, after restore
    expect(h.deleteCount).toBe(1);

    expect(h.routerMessages).toContain('[Recovery] Session restored.');
  });
});
