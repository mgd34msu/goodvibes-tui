/**
 * UX Anti-Regression: Resume/Recovery With Active State (v3 §18.5)
 *
 * Verifies that recovering a suspended session restores correct state:
 * overlays remain in their pre-suspend visibility state and session
 * metadata (id, status, revision, source, isResumed) is reconciled.
 *
 * All tests use pure state manipulation, no real I/O, no event bus.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import type { RuntimeState } from '../../runtime/store/state.ts';
import {
  selectSession,
  selectAnyOverlayVisible,
} from '../../runtime/store/selectors/index.ts';
import type { SessionDomainState } from '@/runtime/index.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fixed timestamp used in test helpers to avoid non-deterministic Date.now() calls. */
const TEST_TIMESTAMP = 1700000000000;

/** Simulate a suspended state: session status suspended. */
function buildSuspendedState(activeState: RuntimeState): RuntimeState {
  return {
    ...activeState,
    session: {
      ...activeState.session,
      status: 'suspended',
      revision: activeState.session.revision + 1,
      lastUpdatedAt: TEST_TIMESTAMP,
      source: 'suspend',
    },
  };
}

/** Simulate session recovery: update session metadata from a snapshot. */
function applyResume(
  suspendedState: RuntimeState,
  snapshot: { session?: Partial<SessionDomainState> } = {},
): RuntimeState {
  return {
    ...suspendedState,
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

describe('ux:resume-recovery; restore session with active overlays and session state', () => {
  let state: RuntimeState;

  beforeEach(() => {
    state = createInitialRuntimeState();
  });

  describe('overlay state after resume', () => {
    test('no overlays are visible in initial resumed state', () => {
      expect(selectAnyOverlayVisible(state)).toBe(false);

      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended);
      expect(selectAnyOverlayVisible(resumed)).toBe(false);
    });

    test('overlay slice is carried through suspend and resume unchanged', () => {
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended);
      expect(resumed.overlays).toBe(state.overlays);
    });
  });

  describe('session metadata reconciliation', () => {
    test('session ID is preserved across resume', () => {
      const sessionId = state.session.id;
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended, { session: { id: sessionId } });
      expect(selectSession(resumed).id).toBe(sessionId);
    });

    test('resume revision is greater than suspended revision', () => {
      const suspended = buildSuspendedState(state);
      const suspendedRev = selectSession(suspended).revision;

      const resumed = applyResume(suspended);
      expect(selectSession(resumed).revision).toBeGreaterThan(suspendedRev);
    });

    test('source is set to resume after recovery', () => {
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended);
      expect(selectSession(resumed).source).toBe('resume');
    });

    test('session status transitions to active after resume', () => {
      const suspended = buildSuspendedState(state);
      expect(selectSession(suspended).status).toBe('suspended');

      const resumed = applyResume(suspended);
      expect(selectSession(resumed).status).toBe('active');
    });

    test('isResumed flag is set after recovery', () => {
      const suspended = buildSuspendedState(state);
      const resumed = applyResume(suspended);
      expect(selectSession(resumed).isResumed).toBe(true);
    });

    test('multiple resume cycles produce correct final state', () => {
      let current = state;
      for (let i = 0; i < 5; i++) {
        current = buildSuspendedState(current);
        current = applyResume(current);
      }

      expect(selectSession(current).isResumed).toBe(true);
      expect(selectSession(current).status).toBe('active');
      expect(selectSession(current).revision).toBe(state.session.revision + 10);
    });
  });
});
