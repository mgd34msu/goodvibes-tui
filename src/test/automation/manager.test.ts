import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import { AutomationManager } from '../../automation/manager.ts';
import { AutomationJobStore } from '../../automation/store/jobs.ts';
import { AutomationRunStore } from '../../automation/store/runs.ts';
import { normalizeCronSchedule, normalizeEverySchedule } from '../../automation/schedules.ts';
import type { LegacySchedulerSnapshot } from '../../automation/migration.ts';
import { AgentManager } from '../../tools/agent/index.ts';
import { _resetAgentExecutorForTest, _setAgentExecutorForTest } from '../../tools/agent/manager.ts';

_setAgentExecutorForTest({
  async runAgent() {
    return new Promise<void>(() => {});
  },
});

describe('AutomationManager', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-manager-'));
    AgentManager.resetInstance();
  });

  afterEach(() => {
    AgentManager.getInstance().clear();
    AgentManager.resetInstance();
    AutomationManager.resetInstance();
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

    const manager = new AutomationManager({
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
    const manager = new AutomationManager({
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
    const manager = new AutomationManager({
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
    const manager = new AutomationManager({
      jobStore: new AutomationJobStore(join(root, 'automation-jobs.json')),
      runStore: new AutomationRunStore(join(root, 'automation-runs.json')),
      legacyStore: new PersistentStore<LegacySchedulerSnapshot>(join(root, 'legacy.json')),
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
    const agent = AgentManager.getInstance().getStatus(run.agentId!);
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
    const manager = new AutomationManager({
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
});

afterEach(() => {
  _resetAgentExecutorForTest();
  _setAgentExecutorForTest({
    async runAgent() {
      return new Promise<void>(() => {});
    },
  });
});
