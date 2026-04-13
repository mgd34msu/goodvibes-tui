import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationJobStore, AutomationRouteStore, AutomationRunStore, AutomationService, AutomationSourceStore } from '../../automation/index.ts';
import { AutomationManager } from '../../automation/manager.ts';
import { ConfigManager } from '../../config/manager.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import { SharedSessionBroker } from '../../control-plane/session-broker.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import type { AutomationJob } from '../../automation/jobs.ts';
import type { AutomationRouteBinding } from '../../automation/routes.ts';
import type { AutomationSourceRecord } from '../../automation/sources.ts';

describe('automation service', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-service-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createManager(): AutomationManager {
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, `bindings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)),
    });
    const configManager = new ConfigManager({
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
    const spawnTask = ({ prompt }: { readonly prompt: string }) => {
      const id = `agent-${++spawnCount}-${prompt.length}`;
      return id;
    };
    return new AutomationManager({
      configManager,
      routeBindings,
      sessionBroker,
      spawnTask,
      cancelTask: () => undefined,
      agentStatusProvider: { getStatus: () => null },
    });
  }

  function createService(): AutomationService {
    return new AutomationService({
      configManager: new ConfigManager({
        workingDir: root,
        configDir: join(root, '.goodvibes', 'tui'),
      }),
      jobs: new AutomationJobStore(join(root, 'jobs.json')),
      runs: new AutomationRunStore(join(root, 'runs.json')),
      routes: new AutomationRouteStore(join(root, 'routes.json')),
      sources: new AutomationSourceStore(join(root, 'sources.json')),
      manager: createManager(),
    });
  }

  test('loads, writes, and reloads automation entities', async () => {
    const source: AutomationSourceRecord = {
      id: 'source-1',
      kind: 'schedule',
      label: 'Scheduler',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    };
    const route: AutomationRouteBinding = {
      id: 'route-1',
      kind: 'thread',
      surfaceKind: 'slack',
      surfaceId: 'surface-1',
      externalId: 'C123',
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
      metadata: {},
    };
    const job: AutomationJob = {
      id: 'job-1',
      labels: [],
      createdAt: 1,
      updatedAt: 1,
      name: 'job',
      status: 'enabled',
      enabled: true,
      schedule: { kind: 'every', intervalMs: 60_000 },
      execution: { target: { kind: 'background' } },
      delivery: { mode: 'none', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
      failure: { action: 'retry', maxConsecutiveFailures: 3, cooldownMs: 30_000, retryPolicy: { maxAttempts: 2, delayMs: 1_000, strategy: 'fixed' } },
      source,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      deleteAfterRun: false,
    };

    const service = createService();
    await service.load();
    await service.upsertSource(source);
    await service.upsertRoute(route);
    await service.upsertJob(job);
    const run = await service.appendRun({
      labels: [],
      createdAt: 1,
      updatedAt: 1,
      jobId: 'job-1',
      status: 'queued',
      triggeredBy: source,
      target: { kind: 'background' },
      execution: { target: { kind: 'background' } },
      queuedAt: 1,
      forceRun: false,
      dueRun: true,
      attempt: 1,
      deliveryIds: [],
    });

    expect(service.listJobs()).toHaveLength(1);
    expect(service.listRuns()).toHaveLength(1);
    expect(service.listRoutes()).toHaveLength(1);
    expect(service.listSources()).toHaveLength(1);
    expect(run.id).toMatch(/^run-/);

    const reloaded = createService();
    await reloaded.load();

    expect(reloaded.getJob('job-1')).toMatchObject({ id: 'job-1' });
    expect(reloaded.listRuns('job-1')).toHaveLength(1);
    expect(reloaded.listRoutes()[0]).toMatchObject({ id: 'route-1' });
    expect(reloaded.listSources()[0]).toMatchObject({ id: 'source-1' });
  });

  test('seeds from legacy scheduler only when empty', async () => {
    const service = createService();
    await service.load();
    await service.seedFromLegacyScheduler({
      tasks: [
        {
          id: 'sched-1',
          name: 'nightly',
          cron: '0 2 * * *',
          prompt: 'nightly status',
          enabled: true,
          runCount: 0,
          missedRuns: 0,
          createdAt: 1,
        },
      ],
    });

    expect(service.listJobs()).toHaveLength(1);
    expect(service.listJobs()[0]?.id).toBe('sched-1');
  });
});
