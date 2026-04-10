import { describe, expect, test } from 'bun:test';

import { createInitialRuntimeState } from '../../runtime/store/state.ts';
import { createInitialAutomationState } from '../../runtime/store/domains/automation.ts';
import { createInitialRoutesState } from '../../runtime/store/domains/routes.ts';
import { createInitialControlPlaneState } from '../../runtime/store/domains/control-plane.ts';
import { createInitialDeliveryState } from '../../runtime/store/domains/deliveries.ts';
import { createInitialWatcherState } from '../../runtime/store/domains/watchers.ts';
import { createInitialSurfaceState } from '../../runtime/store/domains/surfaces.ts';
import type { AutomationJob } from '../../automation/jobs.ts';
import type { AutomationRun } from '../../automation/runs.ts';
import type { AutomationRouteBinding } from '../../automation/routes.ts';
import type { AutomationSourceRecord } from '../../automation/sources.ts';
import type { AutomationDeliveryPolicy } from '../../automation/delivery.ts';
import type { AutomationFailurePolicy } from '../../automation/failures.ts';
import type { AutomationExecutionPolicy } from '../../automation/session-targets.ts';

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('automation domain foundation', () => {
  test('initial automation domain state is empty and counts are zero', () => {
    const state = createInitialAutomationState();
    expect(state.jobs.size).toBe(0);
    expect(state.runs.size).toBe(0);
    expect(state.sources.size).toBe(0);
    expect(state.jobIds).toHaveLength(0);
    expect(state.runIds).toHaveLength(0);
    expect(state.activeRunIds).toHaveLength(0);
    expect(state.failedRunIds).toHaveLength(0);
    expect(state.sourceIds).toHaveLength(0);
    expect(state.totalJobs).toBe(0);
    expect(state.totalRuns).toBe(0);
    expect(state.totalSucceeded).toBe(0);
    expect(state.totalFailed).toBe(0);
    expect(state.totalCancelled).toBe(0);
    expect(state.totalDeadLettered).toBe(0);
  });

  test('initial routing/control-plane/delivery/watcher/surface states are empty', () => {
    expect(createInitialRoutesState().bindings.size).toBe(0);
    expect(createInitialRoutesState().bindingIds).toHaveLength(0);
    expect(createInitialControlPlaneState().clients.size).toBe(0);
    expect(createInitialDeliveryState().deliveryAttempts.size).toBe(0);
    expect(createInitialWatcherState().watchers.size).toBe(0);
    expect(createInitialSurfaceState().surfaces.size).toBe(0);
  });

  test('runtime state includes the new automation-related domains', () => {
    const state = createInitialRuntimeState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);

    const serialized = JSON.stringify(state);
    expect(serialized).toContain('"automation"');
    expect(serialized).toContain('"routes"');
    expect(serialized).toContain('"controlPlane"');
    expect(serialized).toContain('"deliveries"');
    expect(serialized).toContain('"watchers"');
    expect(serialized).toContain('"surfaces"');
  });

  test('automation job, run, route, and source records round-trip through JSON', () => {
    const source: AutomationSourceRecord = {
      id: 'source-1',
      kind: 'schedule',
      label: 'Nightly build watcher',
      surfaceKind: 'webhook',
      routeId: 'route-1',
      enabled: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_001_000,
      metadata: { tenant: 'default' },
    };

    const execution: AutomationExecutionPolicy = {
      target: {
        kind: 'background',
        preserveThread: true,
      },
      modelProvider: 'openai',
      modelId: 'gpt-5.4',
      reasoningEffort: 'medium',
      timeoutMs: 60_000,
      maxAttempts: 2,
      toolAllowlist: ['read', 'write'],
      autoApprove: false,
      sandboxMode: 'inherit',
    };

    const delivery: AutomationDeliveryPolicy = {
      mode: 'surface',
      targets: [
        { kind: 'surface', surfaceKind: 'slack', address: 'C012345' },
      ],
      fallbackTargets: [
        { kind: 'webhook', address: 'https://example.invalid/webhook' },
      ],
      includeSummary: true,
      includeTranscript: false,
      includeLinks: true,
      replyToRouteId: 'route-1',
    };

    const failure: AutomationFailurePolicy = {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 30_000,
      retryPolicy: {
        maxAttempts: 3,
        delayMs: 5_000,
        strategy: 'exponential',
        maxDelayMs: 60_000,
        jitterMs: 500,
      },
      deadLetterRouteId: 'dead-letter-route',
      disableAfterFailures: true,
      notifyRouteId: 'ops-route',
    };

    const job: AutomationJob = {
      id: 'job-1',
      labels: ['ops', 'nightly'],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      name: 'Nightly automation',
      description: 'Run the nightly automation flow.',
      status: 'enabled',
      enabled: true,
      schedule: {
        kind: 'cron',
        expression: '0 2 * * *',
        timezone: 'America/Chicago',
      },
      execution,
      delivery,
      failure,
      source,
      nextRunAt: 1_700_000_360_000,
      lastRunAt: 1_699_999_999_000,
      lastRunId: 'run-1',
      runCount: 4,
      successCount: 3,
      failureCount: 1,
      pausedReason: undefined,
      deleteAfterRun: false,
      archivedAt: undefined,
      createdBy: 'operator',
      updatedBy: 'operator',
      notes: 'Seeded for tests',
    };

    const route: AutomationRouteBinding = {
      id: 'route-1',
      kind: 'thread',
      surfaceKind: 'slack',
      surfaceId: 'surface-1',
      externalId: 'C012345',
      threadId: 'thread-99',
      channelId: 'C012345',
      sessionId: 'session-1',
      jobId: 'job-1',
      runId: 'run-1',
      title: 'Ops thread',
      lastSeenAt: 1_700_000_002_000,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      metadata: { threadTs: '1700000000.000100' },
    };

    const run: AutomationRun = {
      id: 'run-1',
      labels: ['nightly'],
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_002_500,
      jobId: 'job-1',
      status: 'running',
      triggeredBy: source,
      target: execution.target,
      execution,
      scheduleKind: 'cron',
      queuedAt: 1_700_000_001_000,
      startedAt: 1_700_000_001_500,
      endedAt: undefined,
      durationMs: undefined,
      forceRun: false,
      dueRun: true,
      attempt: 1,
      routeId: route.id,
      route,
      deliveryIds: ['delivery-1'],
      deliveryAttempts: [
        {
          id: 'delivery-1',
          runId: 'run-1',
          jobId: 'job-1',
          target: delivery.targets[0],
          status: 'sent',
          startedAt: 1_700_000_002_000,
          endedAt: 1_700_000_002_200,
          responseId: 'msg-1',
        },
      ],
      modelId: 'gpt-5.4',
      providerId: 'openai',
      result: { ok: true },
      error: undefined,
      cancelledReason: undefined,
      createdBy: 'scheduler',
      updatedBy: 'scheduler',
      notes: 'Round-trip test',
    };

    expect(roundTrip(source)).toEqual(source);
    expect(roundTrip(job)).toMatchObject({
      id: 'job-1',
      status: 'enabled',
      schedule: { kind: 'cron', expression: '0 2 * * *' },
      execution: { modelProvider: 'openai', modelId: 'gpt-5.4' },
      delivery: { mode: 'surface' },
      failure: { action: 'retry' },
    });
    expect(roundTrip(route)).toEqual(route);
    expect(roundTrip(run)).toMatchObject({
      id: 'run-1',
      status: 'running',
      routeId: 'route-1',
      deliveryIds: ['delivery-1'],
      result: { ok: true },
    });
  });
});
