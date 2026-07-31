/**
 * client-build-floor-gate.test.ts — the daemon's build floor, on the seam that
 * actually executes work.
 *
 * build-floors.test.ts pins the verdicts. This pins the consequence: a terminal
 * the daemon has declared too old stops taking shared-session work. The path is
 * the real one — a follow-up arrives while an agent is busy, so it queues, and
 * the queued follow-up is handed to the continuation runner when that agent
 * completes. That runner is the one services.ts binds to BOTH the local broker
 * and the wire dispatch, so a message arriving over the daemon's queue takes
 * the same refusal as one raised here.
 *
 * Driven through the real broker rather than a stand-in runner: a copy of the
 * runner would pass this test while the shipped one spawned anyway.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  disposeTestRuntimeServicesAfterAll,
  getTestRuntimeServices,
  resetTestRuntimeServices,
} from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

// The guard latches for the lifetime of the graph it belongs to, so every test
// builds its own rather than inheriting a latch from the one before it.
beforeEach(() => resetTestRuntimeServices());

const FROM_A_CHANNEL = { surfaceKind: 'telegram' as const, surfaceId: 'surface:telegram:test' };

/**
 * A session with an agent already working it, plus a follow-up queued behind
 * that agent — the exact state whose completion runs the continuation runner.
 */
async function sessionWithQueuedFollowUp(
  services: ReturnType<typeof getTestRuntimeServices>,
  title: string,
): Promise<{ sessionId: string; busyAgentId: string }> {
  const session = await services.sessionBroker.createSession({ title });
  // A real running agent, because the broker resolves "busy" through the agent
  // manager's own status rather than the recorded id alone.
  const busyAgentId = await bindRunningAgent(services, session.id, 'hold this session open');

  const queued = await services.sessionBroker.followUpMessage({
    ...FROM_A_CHANNEL,
    sessionId: session.id,
    body: 'answer this when you are done',
  });
  expect(queued.mode).toBe('queued-follow-up');
  return { sessionId: session.id, busyAgentId };
}

async function bindRunningAgent(
  services: ReturnType<typeof getTestRuntimeServices>,
  sessionId: string,
  task: string,
): Promise<string> {
  const record = services.agentManager.spawn({ mode: 'spawn', task });
  await services.sessionBroker.bindAgent(sessionId, record.id);
  return record.id;
}

describe('a terminal below the daemon floor', () => {
  test('runs the queued follow-up while the daemon has asked for nothing', async () => {
    const services = getTestRuntimeServices();
    const { sessionId, busyAgentId } = await sessionWithQueuedFollowUp(services, 'floor-ok');

    const completion = await services.sessionBroker.completeAgent(sessionId, busyAgentId, 'done');

    expect(services.clientBuildGuard.maySharedSessionWork()).toBe(true);
    expect(completion?.continuedAgentId).toBeTruthy();
    expect(completion?.continuedInput?.body).toBe('answer this when you are done');
  });

  test('refuses the queued follow-up once the daemon announces a floor above this build', async () => {
    const services = getTestRuntimeServices();
    const { sessionId, busyAgentId } = await sessionWithQueuedFollowUp(services, 'floor-too-low');

    // What the attach handshake feeds it, from the daemon's /status header.
    expect(services.clientBuildGuard.observeFloor('999.0.0').status).toBe('restart-required');

    const completion = await services.sessionBroker.completeAgent(sessionId, busyAgentId, 'done');

    // Nothing ran, and the message is still queued rather than marked answered
    // by an agent that does not exist.
    expect(completion?.continuedAgentId).toBeUndefined();
    expect(completion?.continuedInput).toBeUndefined();
    expect(services.sessionBroker.getInputs(sessionId).some((input) => input.state === 'queued')).toBe(true);
  });

  test('the refusal holds for later follow-ups, not just the one that hit the floor', async () => {
    const services = getTestRuntimeServices();
    const { sessionId, busyAgentId } = await sessionWithQueuedFollowUp(services, 'floor-stays');
    services.clientBuildGuard.observeFloor('999.0.0');
    await services.sessionBroker.completeAgent(sessionId, busyAgentId, 'done');

    for (const body of ['second', 'third']) {
      const nextAgentId = await bindRunningAgent(services, sessionId, body);
      await services.sessionBroker.followUpMessage({ ...FROM_A_CHANNEL, sessionId, body });
      const completion = await services.sessionBroker.completeAgent(sessionId, nextAgentId, 'done');
      expect(completion?.continuedAgentId).toBeUndefined();
    }
    expect(services.clientBuildGuard.maySharedSessionWork()).toBe(false);
  });
});
