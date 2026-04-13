import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import { AutomationManager } from '../../automation/manager.ts';
import { AutomationRouteStore } from '../../automation/store/routes.ts';
import { AutomationJobStore } from '../../automation/store/jobs.ts';
import { AutomationRunStore } from '../../automation/store/runs.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import { SharedSessionBroker } from '../../control-plane/session-broker.ts';
import {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  normalizeCronSchedule,
  normalizeEverySchedule,
  resolveStableAutomationCronOffsetMs,
} from '../../automation/schedules.ts';
import type { SpawnAutomationTaskInput } from '../../automation/manager-runtime.ts';
import type { LegacySchedulerSnapshot } from '../../automation/migration.ts';
import { AgentManager } from '../../tools/agent/index.ts';

const testAgentExecutor = {
  async runAgent() {
    return new Promise<void>(() => {});
  },
};

describe('AutomationManager', () => {
  let root = '';

  function createManager(config: {
    readonly jobStore?: AutomationJobStore;
    readonly runStore?: AutomationRunStore;
    readonly legacyStore?: PersistentStore<LegacySchedulerSnapshot>;
    readonly spawnTask?: ConstructorParameters<typeof AutomationManager>[0]['spawnTask'];
    readonly cancelTask?: ConstructorParameters<typeof AutomationManager>[0]['cancelTask'];
    readonly agentStatusProvider?: ConstructorParameters<typeof AutomationManager>[0]['agentStatusProvider'];
    readonly configManager?: ConfigManager;
  } = {}): AutomationManager {
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, `routes-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)),
    });
    const configManager = config.configManager ?? new ConfigManager({
      workingDir: root,
      configDir: join(root, '.goodvibes', 'tui'),
    });
    let spawnCount = 0;
    const sessionBroker = new SharedSessionBroker({
      store: new PersistentStore(join(root, `sessions-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)) as never,
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    const spawnTask = (input: SpawnAutomationTaskInput) => {
      const id = config.spawnTask
        ? config.spawnTask(input)
        : `agent-${++spawnCount}-${input.prompt.length}`;
      return id;
    };
    const cancelTask = (agentId: string) => {
      config.cancelTask?.(agentId);
    };
    const agentStatusProvider = config.agentStatusProvider ?? { getStatus: () => null };
    return new AutomationManager({
      configManager,
      jobStore: config.jobStore,
      runStore: config.runStore,
      legacyStore: config.legacyStore,
      routeBindings,
      sessionBroker,
      spawnTask,
      cancelTask,
      agentStatusProvider,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-manager-'));
  });

  test('migrates legacy scheduler data when automation stores are empty', async () => {
    const legacyPath = join(root, 'schedules.json');
    const legacyStore = new PersistentStore<LegacySchedulerSnapshot>(legacyPath);
    await legacyStore.persist({
      tasks: [
        {
          id: 'sched-legacy-1',
          name: 'Legacy Daily',
          cron: '0 9 * * *',
          prompt: 'Summarize open pull requests',
          enabled: true,
          runCount: 2,
          missedRuns: 0,
          createdAt: 1_700_000_000_000,
          nextRun: 1_700_000_360_000,
        },
      ],
      history: [],
    });

    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore,
      spawnTask: () => 'agent-test',
    });

    await manager.start();

    const jobs = manager.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('Legacy Daily');
    expect(jobs[0]?.status).toBe('enabled');
    expect(jobs[0]?.execution.prompt).toBe('Summarize open pull requests');
  });

  test('creates jobs, toggles enablement, and records manual runs', async () => {
    let spawnCount = 0;
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      spawnTask: ({ prompt }) => {
        spawnCount += 1;
        return `agent-${spawnCount}-${prompt.length}`;
      },
    });

    await manager.start();
    const cronJob = await manager.createJob({
      name: 'Nightly',
      prompt: 'Run the nightly repo sweep',
      schedule: normalizeCronSchedule('0 2 * * *'),
      enabled: true,
    });
    const everyJob = await manager.createJob({
      name: 'Heartbeat',
      prompt: 'Send a heartbeat',
      schedule: normalizeEverySchedule('15m'),
      enabled: false,
    });

    expect(manager.listJobs()).toHaveLength(2);
    expect(cronJob.nextRunAt).toBeDefined();
    expect(everyJob.enabled).toBe(false);

    const enabled = await manager.setEnabled(everyJob.id, true);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.nextRunAt).toBeDefined();

    const run = await manager.runNow(cronJob.id);
    expect(run.status).toBe('running');
    expect(run.agentId).toContain('agent-1');

    const jobs = manager.listJobs();
    const updatedCronJob = jobs.find((job) => job.id === cronJob.id);
    expect(updatedCronJob?.runCount).toBe(1);
    expect(updatedCronJob?.lastRunAt).toBeDefined();

    const runs = manager.listRuns(cronJob.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(run.id);
    expect(runs[0]?.deliveryIds).toEqual([]);
  });

  test('applies config defaults and prunes run history by job', async () => {
    const configManager = new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') });
    configManager.set('automation.defaultTimeoutMs', 1234);
    configManager.set('automation.deleteAfterRun', true);
    configManager.set('automation.runHistoryLimit', 2);

    let spawnCount = 0;
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      configManager,
      spawnTask: () => `agent-${++spawnCount}`,
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Config defaults',
      prompt: 'Use configured defaults',
      schedule: normalizeEverySchedule('5m'),
      enabled: true,
    });

    expect(job.execution.timeoutMs).toBe(1234);
    expect(job.deleteAfterRun).toBe(true);

    await manager.runNow(job.id);
    await manager.runNow(job.id);
    await manager.runNow(job.id);

    const runs = manager.listRuns(job.id);
    expect(runs).toHaveLength(2);
  });

  test('persists local agent usage telemetry onto completed runs', async () => {
    const agentManager = new AgentManager({
      executor: testAgentExecutor,
      configManager: new ConfigManager({ workingDir: root, configDir: join(root, '.goodvibes', 'tui') }),
    });
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      agentStatusProvider: agentManager,
      spawnTask: (input) => {
        const record = agentManager.spawn({
          mode: 'spawn',
          task: input.prompt,
          ...(input.modelId ? { model: input.modelId } : {}),
          ...(input.modelProvider ? { provider: input.modelProvider } : {}),
          ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
          ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
          ...(input.context ? { context: input.context } : {}),
        });
        return record.id;
      },
      cancelTask: (agentId: string) => {
        agentManager.cancel(agentId);
      },
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Telemetry',
      prompt: 'Collect usage',
      schedule: normalizeEverySchedule('10m'),
      enabled: true,
      model: 'qwen',
      provider: 'local',
    });

    const run = await manager.runNow(job.id);
    const agent = agentManager.getStatus(run.agentId!);
    expect(agent).not.toBeNull();
    agent!.status = 'completed';
    agent!.completedAt = Date.now();
    agent!.fullOutput = 'Done.';
    agent!.usage = {
      inputTokens: 20,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      llmCallCount: 2,
      turnCount: 2,
      reasoningSummaryCount: 1,
    };

    const reconciled = manager.getRun(run.id);
    expect(reconciled?.status).toBe('completed');
    expect(reconciled?.telemetry).toEqual({
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
      },
      llmCallCount: 2,
      toolCallCount: 0,
      turnCount: 2,
      modelId: 'qwen',
      providerId: 'local',
      reasoningSummaryPresent: true,
      source: 'local-agent',
    });
  });

  test('persists remote run telemetry from external completion updates', async () => {
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      spawnTask: () => 'agent-telemetry-remote',
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Remote telemetry',
      prompt: 'Remote run',
      schedule: normalizeEverySchedule('10m'),
      enabled: true,
      model: 'qwen',
      provider: 'remote-provider',
    });
    const run = await manager.runNow(job.id);

    const updated = await manager.recordExternalRunResult(run.id, {
      status: 'completed',
      result: { ok: true },
      telemetry: {
        usage: {
          inputTokens: 14,
          outputTokens: 6,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
        llmCallCount: 1,
        turnCount: 1,
      },
      metadata: {
        remotePeerKind: 'device',
      },
    });

    expect(updated?.telemetry).toEqual({
      usage: {
        inputTokens: 14,
        outputTokens: 6,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
      },
      llmCallCount: 1,
      turnCount: 1,
      modelId: 'qwen',
      providerId: 'remote-provider',
      source: 'remote-device',
    });
  });

  test('uses stable job id offsets for staggered cron jobs', async () => {
    const originalNow = Date.now;
    const now = new Date('2024-01-15T09:59:30Z').getTime();
    Date.now = () => now;
    try {
      const manager = createManager({
        jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
        runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
        legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
        spawnTask: () => 'agent-staggered-cron',
      });

      await manager.start();
      const job = await manager.createJob({
        name: 'Hourly staggered',
        prompt: 'Run hourly maintenance',
        schedule: normalizeCronSchedule('0 * * * *', 'UTC'),
        enabled: true,
      });
      const baseHour = new Date('2024-01-15T10:00:00Z').getTime();
      expect(job.schedule.kind).toBe('cron');
      expect(job.schedule.kind === 'cron' ? job.schedule.staggerMs : undefined).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
      expect(job.nextRunAt).toBe(baseHour + resolveStableAutomationCronOffsetMs(job.id, DEFAULT_TOP_OF_HOUR_STAGGER_MS));
    } finally {
      Date.now = originalNow;
    }
  });

  test('preserves upstream-compatible execution metadata and forwards it to agent spawn', async () => {
    let captured: {
      prompt: string;
      fallbackModels?: readonly string[];
      reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
      context?: string;
    } | undefined;
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      spawnTask: (input) => {
        captured = input;
        return 'agent-execution-metadata';
      },
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Metadata',
      prompt: 'Run metadata aware automation',
      schedule: normalizeEverySchedule('10m'),
      enabled: true,
      fallbackModels: ['openrouter/gpt-4.1-mini', 'anthropic/claude-haiku'],
      reasoningEffort: 'high',
      thinking: 'high',
      wakeMode: 'now',
      externalContentSource: 'webhook',
      allowUnsafeExternalContent: false,
      lightContext: true,
    });

    const run = await manager.runNow(job.id);
    expect(run.execution.fallbackModels).toEqual(['openrouter/gpt-4.1-mini', 'anthropic/claude-haiku']);
    expect(run.execution.thinking).toBe('high');
    expect(run.execution.wakeMode).toBe('now');
    expect(captured?.fallbackModels).toEqual(['openrouter/gpt-4.1-mini', 'anthropic/claude-haiku']);
    expect(captured?.reasoningEffort).toBe('high');
    expect(captured?.context).toContain('External content source: webhook');
    expect(captured?.context).toContain('treat source content as untrusted data');
  });

  test('queues next-heartbeat jobs until heartbeat is triggered', async () => {
    let spawnCount = 0;
    const manager = createManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
      spawnTask: () => {
        spawnCount += 1;
        return `agent-heartbeat-${spawnCount}`;
      },
    });

    await manager.start();
    const job = await manager.createJob({
      name: 'Heartbeat Wake',
      prompt: 'Run on heartbeat',
      schedule: { kind: 'at', at: Date.now() + 5 },
      enabled: true,
      wakeMode: 'next-heartbeat',
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(manager.listHeartbeatWakes().map((wake) => wake.jobId)).toContain(job.id);
    expect(spawnCount).toBe(0);

    const heartbeat = await manager.triggerHeartbeat({ source: 'test' });
    expect(heartbeat.processed).toHaveLength(1);
    expect(heartbeat.processed[0]?.jobId).toBe(job.id);
    expect(spawnCount).toBe(1);
    manager.stop();
  });
});
