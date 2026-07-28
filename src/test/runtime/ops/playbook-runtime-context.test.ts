import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../../runtime/store/index.ts';
import { createStuckTurnPlaybook } from '@/runtime/index.ts';
import { createSessionUnrecoverablePlaybook } from '@/runtime/index.ts';

describe('ops playbook runtime context', () => {
  test('stuck-turn checks inspect live conversation state', async () => {
    const bus = new RuntimeEventBus();
    const store = createRuntimeStore();
    const now = 1_700_000_100_000;

    store.setState((state) => ({
      ...state,
      conversation: {
        ...state.conversation,
        currentTurnId: 'turn-live',
        turnState: 'streaming',
        turnStartedAt: now - 45_000,
        activeToolCalls: new Map([
          ['call-1', {
            callId: 'call-1',
            toolName: 'edit',
            args: '{}',
            state: 'executing',
            stateEnteredAt: now - 5_000,
            phaseTimestamps: { executing: now - 5_000 },
          }],
        ]),
      },
    }));

    const runtimeContext = {
      runtimeBus: bus,
      store,
      recoveryFilePath: join(tmpdir(), 'missing-recovery.jsonl'),
      lastSessionPointerPath: join(tmpdir(), 'missing-last-session.json'),
      now: () => now,
      lastEventAt: now,
      sessionRecoveryFailedCount: 0,
      detach: () => {},
    };
    const playbook = createStuckTurnPlaybook(() => runtimeContext);
    const timeoutCheck = playbook.checks.find((check) => check.id === 'turn.timeout-elapsed');
    const pendingToolsCheck = playbook.checks.find((check) => check.id === 'turn.pending-tool-calls');

    expect(timeoutCheck).toBeDefined();
    expect(pendingToolsCheck).toBeDefined();

    const timeoutResult = await timeoutCheck!.run();
    const pendingResult = await pendingToolsCheck!.run();

    expect(timeoutResult.passed).toBe(false);
    expect(timeoutResult.summary).toContain('exceeded');
    expect(pendingResult.passed).toBe(false);
    expect(pendingResult.context?.pendingToolCalls).toBe(1);
  });

  test('session-unrecoverable checks inspect live recovery state and recovery artifact', async () => {
    const tmpDir = makeProjectTempDir(`gv-playbook-${randomUUID()}`);
    const recoveryFilePath = join(tmpDir, 'recovery.jsonl');
    const lastSessionPointerPath = join(tmpDir, 'last-session.json');

    try {
      writeFileSync(recoveryFilePath, `${JSON.stringify({ type: 'meta', sessionId: 'sess-1' })}\n`);
      writeFileSync(lastSessionPointerPath, JSON.stringify({ sessionId: 'sess-1' }));

      const bus = new RuntimeEventBus();
      const store = createRuntimeStore();
      const now = 1_700_000_200_000;

      store.setState((state) => ({
        ...state,
        session: {
          ...state.session,
          recoveryState: 'failed',
          recoveryError: 'session state corrupted',
        },
      }));

      const runtimeContext = {
        runtimeBus: bus,
        store,
        recoveryFilePath,
        lastSessionPointerPath,
        now: () => now,
        lastEventAt: now,
        sessionRecoveryFailedCount: 1,
        sessionRecoveryFailedAt: now,
        detach: () => {},
      };

      bus.emit('session', createEventEnvelope(
        'SESSION_RECOVERY_FAILED',
        { type: 'SESSION_RECOVERY_FAILED', sessionId: 'sess-1', error: 'state_corruption' },
        { sessionId: 'sess-1', source: 'test' },
      ));

      await flushMicrotasks();
      const playbook = createSessionUnrecoverablePlaybook(() => runtimeContext);
      const attemptsCheck = playbook.checks.find((check) => check.id === 'session.recovery-attempts');
      const stateFileCheck = playbook.checks.find((check) => check.id === 'session.state-file');

      expect(attemptsCheck).toBeDefined();
      expect(stateFileCheck).toBeDefined();

      const attemptsResult = await attemptsCheck!.run();
      const stateFileResult = await stateFileCheck!.run();

      expect(attemptsResult.passed).toBe(false);
      expect(attemptsResult.summary).toContain('failed');
      expect(stateFileResult.passed).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
