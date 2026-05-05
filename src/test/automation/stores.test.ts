import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutomationJobStore,
  AutomationRouteStore,
  AutomationRunStore,
  AutomationSourceStore,
} from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationSourceRecord } from '@pellux/goodvibes-sdk/platform/automation';

describe('automation persistent stores', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('persists and reloads jobs, runs, routes, and sources', async () => {
    const jobs = new AutomationJobStore(join(root, 'jobs.json'));
    const runs = new AutomationRunStore(join(root, 'runs.json'));
    const routes = new AutomationRouteStore(join(root, 'routes.json'));
    const sources = new AutomationSourceStore(join(root, 'sources.json'));

    const source: AutomationSourceRecord = {
      id: 'source-1',
      kind: 'schedule',
      label: 'Scheduler',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
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
    const run: AutomationRun = {
      id: 'run-1',
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
    };

    await jobs.save([job]);
    await runs.save([run]);
    await routes.save([route]);
    await sources.save([source]);

    await expect(jobs.load()).resolves.toMatchObject({ jobs: [job] });
    await expect(runs.load()).resolves.toMatchObject({ runs: [run] });
    await expect(routes.load()).resolves.toMatchObject({ routes: [route] });
    await expect(sources.load()).resolves.toMatchObject({ sources: [source] });
  });

  test('requires explicit store ownership when no direct path is provided', () => {
    expect(() => new AutomationJobStore({})).toThrow(
      'Automation stores require an explicit controlPlaneDir or configManager.getControlPlaneConfigDir().',
    );
    expect(() => new AutomationRunStore({})).toThrow(
      'Automation stores require an explicit controlPlaneDir or configManager.getControlPlaneConfigDir().',
    );
    expect(() => new AutomationRouteStore({})).toThrow(
      'Automation stores require an explicit controlPlaneDir or configManager.getControlPlaneConfigDir().',
    );
    expect(() => new AutomationSourceStore({})).toThrow(
      'Automation stores require an explicit controlPlaneDir or configManager.getControlPlaneConfigDir().',
    );
  });
});
