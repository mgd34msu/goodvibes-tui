/**
 * Integration coverage for announceResumeState(): the fixture-dir matrix the
 * work order calls for (session only / +checkpoints / +chain history / none),
 * exercised against REAL files — a real SessionManager-saved session, a real
 * last-session.json pointer, and a real WrfcChain array — not hand-parsed
 * JSON, so this proves the notice is grounded in the actual on-disk shapes.
 */
import { describe, expect, test } from 'bun:test';
import { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import { writeLastSessionPointer } from '@/runtime/index.ts';
import type { WrfcChain } from '@pellux/goodvibes-sdk/platform/agents';
import { announceResumeState, type ResumeNoticeDeps } from '@/runtime/resume-notice.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { makeTestSurface } from '../helpers/session-surface.ts';

function makeChain(overrides: Partial<WrfcChain> = {}): WrfcChain {
  return {
    id: `chain-${crypto.randomUUID().slice(0, 8)}`,
    state: 'failed',
    task: 'implement the feature',
    ownerAgentId: 'agent-owner',
    allAgentIds: ['agent-owner'],
    fixAttempts: 0,
    reviewCycles: 0,
    reviewScores: [],
    createdAt: Date.now(),
    completedAt: Date.now(),
    ownerDecisions: [
      { id: '1', ts: new Date().toISOString(), action: 'chain_cancelled', state: 'failed', reason: 'operator killed it' },
    ],
    ...overrides,
  } as WrfcChain;
}

function saveFixtureSession(workingDirectory: string, sessionId: string, userTurns: number): void {
  const sm = new SessionManager(workingDirectory, { surface: makeTestSurface(workingDirectory) });
  const messages = Array.from({ length: userTurns }, (_, i) => ([
    { role: 'user', content: `turn ${i}` },
    { role: 'assistant', content: `reply ${i}` },
  ])).flat();
  sm.save(sessionId, messages, { title: 'fixture', model: 'test-model', provider: 'test', timestamp: Date.now() });
  writeLastSessionPointer(sessionId, { surface: makeTestSurface(workingDirectory) });
}

function baseDeps(workingDirectory: string): Omit<ResumeNoticeDeps, 'router' | 'checkpointManager' | 'chainHistory' | 'memoryAvailable'> {
  return {
    surface: makeTestSurface(workingDirectory),
    sessionManager: new SessionManager(workingDirectory, { surface: makeTestSurface(workingDirectory) }),
  };
}

describe('announceResumeState — fixture-dir matrix', () => {
  test('none: fresh directory with no session, no checkpoints, no chain history prints nothing', async () => {
    const dir = makeProjectTempDir('gv-resume-none');
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: undefined,
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages).toHaveLength(0);
  });

  test('session only: last-session.json + a real saved session, checkpoint manager available with zero checkpoints, no chain history', async () => {
    const dir = makeProjectTempDir('gv-resume-session-only');
    saveFixtureSession(dir, 'sess-abc', 3);
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => [] },
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe('Previous session found: 3 turns, 0 checkpoints — /resume to continue (or /session resume sess-abc directly)');
    // Truthful: no fabricated checkpoints/recall/chain hints.
    expect(messages[0]).not.toContain('/checkpoints');
    expect(messages[0]).not.toContain('/recall');
    expect(messages[0]).not.toContain('last chain');
  });

  test('+checkpoints: same session, checkpoint manager reports 2 real checkpoints', async () => {
    const dir = makeProjectTempDir('gv-resume-plus-checkpoints');
    saveFixtureSession(dir, 'sess-abc', 1);
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => [{ id: 'wcp_1' }, { id: 'wcp_2' }] as never },
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe('Previous session found: 1 turn, 2 checkpoints — /resume to continue (or /session resume sess-abc directly) · /checkpoints to browse');
  });

  test('+chain history: same session + checkpoints, plus a retained terminal chain (cancelled)', async () => {
    const dir = makeProjectTempDir('gv-resume-plus-chain');
    saveFixtureSession(dir, 'sess-abc', 2);
    const messages: string[] = [];
    const chain = makeChain({ state: 'failed' }); // last owner decision: chain_cancelled

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => [{ id: 'wcp_1' }] as never },
      chainHistory: [chain],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe(
      'Previous session found: 2 turns, 1 checkpoint, last chain: cancelled — /resume to continue (or /session resume sess-abc directly) · /checkpoints to browse',
    );
  });

  test('memory available adds the /recall hint on top of the full combo', async () => {
    const dir = makeProjectTempDir('gv-resume-memory');
    saveFixtureSession(dir, 'sess-abc', 1);
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => [] },
      chainHistory: [],
      memoryAvailable: true,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages[0]).toContain('/recall for memory');
  });

  test('a stale last-session.json pointing at a deleted session file is treated as no session (never a broken /session resume hint)', async () => {
    const dir = makeProjectTempDir('gv-resume-stale-pointer');
    writeLastSessionPointer('ghost-session-id', { surface: makeTestSurface(dir) });
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => [{ id: 'wcp_1' }] as never },
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    // Still reports the checkpoint (real, independent signal) but never a
    // dangling resume pointer for a session that no longer exists.
    expect(messages).toHaveLength(1);
    expect(messages[0]).not.toContain('/session resume');
    expect(messages[0]).not.toContain('ghost-session-id');
    expect(messages[0]).toStartWith('Workspace history found:');
  });

  test('a rejecting checkpoint manager (cached init() failure) is treated as unknown, not zero — no false "0 checkpoints" claim', async () => {
    const dir = makeProjectTempDir('gv-resume-checkpoint-broken');
    saveFixtureSession(dir, 'sess-abc', 1);
    const messages: string[] = [];

    await announceResumeState({
      ...baseDeps(dir),
      checkpointManager: { list: async () => { throw new Error('init() rejected forever'); } },
      chainHistory: [],
      memoryAvailable: false,
      router: { high: (m) => messages.push(m) },
    });

    expect(messages[0]).toBe('Previous session found: 1 turn — /resume to continue (or /session resume sess-abc directly)');
    expect(messages[0]).not.toContain('checkpoint');
  });
});
