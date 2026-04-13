import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationManager } from '../../automation/manager.ts';
import { normalizeEverySchedule } from '../../automation/schedules.ts';
import { AutomationJobStore } from '../../automation/store/jobs.ts';
import { AutomationRouteStore } from '../../automation/store/routes.ts';
import { AutomationRunStore } from '../../automation/store/runs.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import { SharedSessionBroker } from '../../control-plane/session-broker.ts';
import { ConfigManager } from '../../config/manager.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { LegacySchedulerSnapshot } from '../../automation/migration.ts';
import { AgentManager } from '../../tools/agent/index.ts';

const testAgentExecutor = {
  async runAgent() {
    return new Promise<void>(() => {});
  },
};

describe('AutomationManager target semantics', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-targets-'));
  });

  function buildManager(spawnTask?: (prompt: string) => string) {
    const liveAgents = new Map<string, 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'>();
    const configManager = new ConfigManager({
      workingDir: root,
      configDir: join(root, '.goodvibes', 'tui'),
    });
    const agentManager = new AgentManager({
      executor: testAgentExecutor,
      configManager,
    });
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'automation-routes.json')),
    });
    const sessionBroker = new SharedSessionBroker({
      store: new PersistentStore(join(root, 'shared-sessions.json')),
      routeBindings,
      agentStatusProvider: {
        getStatus(agentId) {
          const status = liveAgents.get(agentId);
          return status ? { id: agentId, status } : null;
        },
      },
      messageSender: {
        send(_fromId, toId) {
          return liveAgents.has(toId);
        },
      },
    });
    const manager = new AutomationManager({
      configManager,
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      routeBindings,
      sessionBroker,
      spawnTask: ({ prompt }) => {
        return spawnTask ? spawnTask(prompt) : `agent-${Math.random().toString(16).slice(2, 8)}`;
      },
      cancelTask: () => undefined,
      agentStatusProvider: { getStatus: () => null },
    });
    return {
      manager,
      agentManager,
      routeBindings,
      sessionBroker,
      setLiveAgent(agentId: string, status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' = 'pending') {
        liveAgents.set(agentId, status);
      },
    };
  }

  test('reuses a pinned session across runs', async () => {
    const prompts: string[] = [];
    const { manager, sessionBroker } = buildManager((prompt) => {
      prompts.push(prompt);
      return `agent-${prompts.length}`;
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Pinned automation',
      prompt: 'Summarize the session state',
      schedule: normalizeEverySchedule('5m'),
      target: {
        kind: 'pinned',
        createIfMissing: true,
      },
    });

    const runA = await manager.runNow(job.id);
    const runB = await manager.runNow(job.id);
    const persistedJob = manager.getJob(job.id);

    expect(runA.sessionId).toBe(runB.sessionId);
    expect(runA.continuationMode).toBe('shared-session');
    expect(runB.continuationMode).toBe('shared-session');
    expect(persistedJob?.execution.target.pinnedSessionId).toBe(`auto-pin-${job.id}`);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Continue the shared control-plane session');

    const messages = sessionBroker.getMessages(runA.sessionId!, 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.displayName).toContain('Automation');
  });

  test('binds route targets into shared sessions and updates the binding', async () => {
    const { manager, routeBindings, sessionBroker } = buildManager((prompt) => `agent-${prompt.length}`);

    await manager.start();
    const binding = await routeBindings.upsertBinding({
      kind: 'thread',
      surfaceKind: 'slack',
      surfaceId: 'surface:slack',
      externalId: 'C123',
      threadId: '171234.5',
      title: 'Slack thread',
      metadata: { channel: '#ops' },
    });

    const job = await manager.createJob({
      name: 'Route-bound automation',
      prompt: 'Post the weekly route summary',
      schedule: normalizeEverySchedule('10m'),
      target: {
        kind: 'route',
        routeId: binding.id,
        preserveThread: true,
        threadId: '171234.5',
      },
    });

    const run = await manager.runNow(job.id);
    const updatedBinding = routeBindings.getBinding(binding.id);

    expect(run.routeId).toBe(binding.id);
    expect(run.sessionId).toBeDefined();
    expect(updatedBinding?.sessionId).toBe(run.sessionId);
    expect(updatedBinding?.jobId).toBe(job.id);
    expect(updatedBinding?.runId).toBe(run.id);
    expect(sessionBroker.getSession(run.sessionId!)).not.toBeNull();
  });

  test('uses the current shared session when targeted', async () => {
    const { manager, sessionBroker } = buildManager((prompt) => `agent-${prompt.length}`);

    await manager.start();
    const existingSession = await sessionBroker.createSession({
      id: 'sess-current',
      title: 'Terminal UI session',
      metadata: { source: 'tui' },
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'surface:tui',
        displayName: 'Terminal UI',
        lastSeenAt: Date.now(),
      },
    });

    const job = await manager.createJob({
      name: 'Current session automation',
      prompt: 'Continue the active terminal workflow',
      schedule: normalizeEverySchedule('15m'),
      target: {
        kind: 'current',
        surfaceKind: 'tui',
        createIfMissing: false,
      },
    });

    const run = await manager.runNow(job.id);

    expect(run.sessionId).toBe(existingSession.id);
    expect(run.continuationMode).toBe('shared-session');
    expect(sessionBroker.getMessages(existingSession.id, 10)).toHaveLength(1);
  });

  test('maps the main target alias to the preferred TUI shared session', async () => {
    const { manager, sessionBroker } = buildManager((prompt) => `agent-${prompt.length}`);

    await manager.start();
    const existingSession = await sessionBroker.createSession({
      id: 'sess-main',
      title: 'Main Terminal UI session',
      metadata: { source: 'tui' },
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'surface:tui',
        displayName: 'Terminal UI',
        lastSeenAt: Date.now(),
      },
    });

    const job = await manager.createJob({
      name: 'Main target automation',
      prompt: 'Continue the main terminal workflow',
      schedule: normalizeEverySchedule('15m'),
      target: {
        kind: 'main',
        createIfMissing: false,
      },
    });

    const run = await manager.runNow(job.id);

    expect(run.sessionId).toBe(existingSession.id);
    expect(run.target.kind).toBe('main');
    expect(run.continuationMode).toBe('shared-session');
    expect(sessionBroker.getMessages(existingSession.id, 10)).toHaveLength(1);
  });

  test('forwards to a live agent instead of spawning a new one when the target session is active', async () => {
    let spawnCount = 0;
    const { manager, agentManager, sessionBroker, setLiveAgent } = buildManager(() => {
      spawnCount += 1;
      return `spawned-${spawnCount}`;
    });

    await manager.start();
    const liveAgent = agentManager.spawn({
      mode: 'spawn',
      task: 'Keep the shared session active',
    });
    const session = await sessionBroker.createSession({
      id: 'sess-live',
      title: 'Live shared session',
      metadata: { source: 'tui' },
      participant: {
        surfaceKind: 'tui',
        surfaceId: 'surface:tui',
        displayName: 'Terminal UI',
        lastSeenAt: Date.now(),
      },
    });
    setLiveAgent(liveAgent.id, 'pending');
    await sessionBroker.bindAgent(session.id, liveAgent.id);

    const job = await manager.createJob({
      name: 'Live continuation automation',
      prompt: 'Add this instruction to the active session',
      schedule: normalizeEverySchedule('20m'),
      target: {
        kind: 'session',
        sessionId: session.id,
        createIfMissing: false,
      },
    });

    const run = await manager.runNow(job.id);

    expect(run.continuationMode).toBe('continued-live');
    expect(run.agentId).toBe(liveAgent.id);
    expect(spawnCount).toBe(0);
    expect(sessionBroker.getMessages(session.id, 10)).toHaveLength(1);
  });
});
