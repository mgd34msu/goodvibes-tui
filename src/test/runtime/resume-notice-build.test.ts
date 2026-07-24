import { describe, expect, test } from 'bun:test';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import { buildResumeNotice, describeChainOutcome, mostRecentChain } from '@/runtime/resume-notice.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeChain(overrides: Partial<WrfcChain> = {}): WrfcChain {
  return {
    id: `chain-${crypto.randomUUID().slice(0, 8)}`,
    state: 'engineering',
    task: 'implement the feature',
    ownerAgentId: 'agent-owner',
    allAgentIds: ['agent-owner'],
    fixAttempts: 0,
    reviewCycles: 0,
    reviewScores: [],
    createdAt: Date.now(),
    ownerDecisions: [],
    ...overrides,
  } as WrfcChain;
}

// ─── describeChainOutcome ────────────────────────────────────────────────────

describe('describeChainOutcome', () => {
  test('passed chain reports passed', () => {
    expect(describeChainOutcome(makeChain({ state: 'passed' }))).toBe('passed');
  });

  test('a still-non-terminal chain (genuinely interrupted) reports interrupted', () => {
    expect(describeChainOutcome(makeChain({ state: 'reviewing' }))).toBe('interrupted');
  });

  test('a failed chain whose last owner decision is chain_cancelled reports cancelled, not failed', () => {
    const chain = makeChain({
      state: 'failed',
      ownerDecisions: [
        { id: '1', ts: new Date().toISOString(), action: 'spawn_engineer', state: 'engineering', reason: 'start' },
        { id: '2', ts: new Date().toISOString(), action: 'chain_cancelled', state: 'failed', reason: 'operator killed it' },
      ],
    });
    expect(describeChainOutcome(chain)).toBe('cancelled');
  });

  test('an ordinary failed chain (last decision is chain_failed) reports failed', () => {
    const chain = makeChain({
      state: 'failed',
      ownerDecisions: [
        { id: '1', ts: new Date().toISOString(), action: 'review_failed', state: 'reviewing', reason: 'score too low' },
        { id: '2', ts: new Date().toISOString(), action: 'chain_failed', state: 'failed', reason: 'gate exhausted' },
      ],
    });
    expect(describeChainOutcome(chain)).toBe('failed');
  });

  test('a zombie-reaped chain (no owner decision recorded for the reap) reports failed, not cancelled', () => {
    const chain = makeChain({
      state: 'failed',
      error: 'zombie chain reaped at rehydrate: no member agent survived the restart',
      ownerDecisions: [
        { id: '1', ts: new Date().toISOString(), action: 'spawn_engineer', state: 'engineering', reason: 'start' },
      ],
    });
    expect(describeChainOutcome(chain)).toBe('failed');
  });

  test('a failed chain with no owner decisions at all reports failed (never throws)', () => {
    expect(describeChainOutcome(makeChain({ state: 'failed', ownerDecisions: [] }))).toBe('failed');
  });

  // ── first-class failureKind (current SDK) ──
  test('failureKind cancelled reports cancelled even with no chain_cancelled decision logged', () => {
    const chain = makeChain({ state: 'failed', failureKind: 'cancelled', ownerDecisions: [] });
    expect(describeChainOutcome(chain)).toBe('cancelled');
  });

  test('failureKind other/transport reports failed', () => {
    expect(describeChainOutcome(makeChain({ state: 'failed', failureKind: 'other', ownerDecisions: [] }))).toBe('failed');
    expect(describeChainOutcome(makeChain({ state: 'failed', failureKind: 'transport', ownerDecisions: [] }))).toBe('failed');
  });

  test('failureKind takes precedence over the owner-decision log (a genuine failure is not misread as cancelled)', () => {
    const chain = makeChain({
      state: 'failed',
      failureKind: 'other',
      ownerDecisions: [
        { id: '1', ts: new Date().toISOString(), action: 'chain_cancelled', state: 'failed', reason: 'stale decision from an earlier attempt' },
      ],
    });
    expect(describeChainOutcome(chain)).toBe('failed');
  });
});

// ─── mostRecentChain ─────────────────────────────────────────────────────────

describe('mostRecentChain', () => {
  test('empty set returns null', () => {
    expect(mostRecentChain([])).toBeNull();
  });

  test('picks the chain with the latest completedAt', () => {
    const older = makeChain({ completedAt: 1000 });
    const newer = makeChain({ completedAt: 2000 });
    expect(mostRecentChain([older, newer])!.id).toBe(newer.id);
  });

  test('falls back to createdAt when completedAt is absent (still-interrupted chains)', () => {
    const older = makeChain({ createdAt: 1000 });
    const newer = makeChain({ createdAt: 2000 });
    expect(mostRecentChain([older, newer])!.id).toBe(newer.id);
  });
});

// ─── buildResumeNotice ───────────────────────────────────────────────────────

describe('buildResumeNotice', () => {
  test('nothing to report (no session, no checkpoints, no chain history, no recovery snapshot) prints no notice', () => {
    expect(buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: null,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    })).toBeNull();
  });

  test('session only: reports turns and 0 checkpoints, hints /session resume <id> with the real id, no checkpoints/recall hint', () => {
    const notice = buildResumeNotice({
      turnCount: 5,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).toBe('Previous session found: 5 turns, 0 checkpoints — /session resume abc123 to continue');
  });

  test('session + checkpoints: adds the /checkpoints hint', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 3,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).toBe('Previous session found: 1 turn, 3 checkpoints — /session resume abc123 to continue · /checkpoints to browse');
  });

  test('session + checkpoints + chain history: adds the last-chain clause', () => {
    const notice = buildResumeNotice({
      turnCount: 4,
      lastSessionId: 'abc123',
      checkpointCount: 2,
      lastChainOutcome: 'cancelled',
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).toBe(
      'Previous session found: 4 turns, 2 checkpoints, last chain: cancelled — /session resume abc123 to continue · /checkpoints to browse',
    );
  });

  test('memory available adds the /recall hint', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: true,
      recoverySnapshot: null,
    });
    expect(notice).toBe('Previous session found: 1 turn, 0 checkpoints — /session resume abc123 to continue · /recall for memory');
  });

  test('no chain history means no chain clause at all (not a fabricated "none")', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).not.toContain('last chain');
  });

  test('checkpoint manager unavailable (null, not zero): no checkpoint claim and no /checkpoints hint', () => {
    const notice = buildResumeNotice({
      turnCount: 2,
      lastSessionId: 'abc123',
      checkpointCount: null,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).toBe('Previous session found: 2 turns — /session resume abc123 to continue');
    expect(notice).not.toContain('checkpoint');
  });

  test('no session but checkpoints and chain history exist: leads with "Workspace history found", no /session resume hint', () => {
    const notice = buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: 4,
      lastChainOutcome: 'passed',
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).toBe('Workspace history found: 4 checkpoints, last chain: passed — /checkpoints to browse');
    expect(notice).not.toContain('/session resume');
  });

  test('no session, checkpoint manager available but zero checkpoints, no chain history, no recovery snapshot: nothing to report', () => {
    expect(buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    })).toBeNull();
  });

  // ── recovery snapshot clause (bare-launch never auto-restores; the notice
  // is the only surface for a live recovery snapshot — it never claims a
  // crash happened, since checkRecoveryFile has no liveness check and a
  // second TUI still running in the same workspace would see the same file) ──

  test('a resumable recovery snapshot for a DIFFERENT session adds a distinct restore hint and summary clause', () => {
    const notice = buildResumeNotice({
      turnCount: 5,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: { sessionId: 'xyz789', resumable: true },
    });
    expect(notice).toBe(
      'Previous session found: 5 turns, 0 checkpoints, recovery snapshot found — /session resume abc123 to continue · /session resume xyz789 to restore it',
    );
  });

  test('a recovery snapshot for the SAME session as the one already hinted does not repeat the command', () => {
    const notice = buildResumeNotice({
      turnCount: 5,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: { sessionId: 'abc123', resumable: true },
    });
    expect(notice).toBe('Previous session found: 5 turns, 0 checkpoints, recovery snapshot found — /session resume abc123 to continue');
    expect(notice!.match(/\/session resume/g)?.length).toBe(1);
  });

  test('a recovery snapshot whose session was never fully saved (not resumable) is reported without a command', () => {
    const notice = buildResumeNotice({
      turnCount: null,
      lastSessionId: null,
      checkpointCount: null,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: { sessionId: 'xyz789', resumable: false },
    });
    expect(notice).toBe('Workspace history found: recovery snapshot found');
    expect(notice).not.toContain('/session resume');
  });

  test('no recovery snapshot: no recovery-snapshot clause at all (not a fabricated one)', () => {
    const notice = buildResumeNotice({
      turnCount: 1,
      lastSessionId: 'abc123',
      checkpointCount: 0,
      lastChainOutcome: null,
      memoryAvailable: false,
      recoverySnapshot: null,
    });
    expect(notice).not.toContain('recovery snapshot');
  });
});
