// ---------------------------------------------------------------------------
// src/test/panels/control-plane/_shared.ts
//
// Shared fixtures and broker setup/teardown used by the per-panel control-
// plane operator suites in this directory (WO-006 decongestion of the
// former control-plane-panels.test.ts).
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore, createDomainDispatch } from '../../../runtime/store/index.ts';
import { AutomationControlPanel } from '../../../panels/automation-control-panel.ts';
import { ApprovalBroker, SharedSessionBroker, ControlPlaneGateway } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation';
import { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels';
import type { AutomationDeliveryAttempt } from '@pellux/goodvibes-sdk/platform/automation';
import type { WatcherRecord } from '@/runtime/index.ts';
import type { ControlPlaneClientRecord } from '@/runtime/index.ts';
import { PersistentStore } from '@pellux/goodvibes-sdk/platform/state';
import { resetTestRuntimeServices } from '../../helpers/runtime-services.ts';

export { createRuntimeStore, createDomainDispatch, ControlPlaneGateway };

export function linesText(lines: ReturnType<AutomationControlPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

export function baseJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  const now = Date.now();
  return {
    id: 'job-nightly',
    labels: [],
    createdAt: now - 10_000,
    updatedAt: now - 2_000,
    name: 'Nightly Sweep',
    description: 'Run a nightly repo sweep',
    status: 'enabled',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 0 * * *' },
    execution: { target: { kind: 'isolated' }, modelId: 'gpt-test', toolAllowlist: ['read'], timeoutMs: 10_000 },
    delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeSummary: true, includeTranscript: false, includeLinks: true },
    failure: {
      action: 'retry',
      maxConsecutiveFailures: 3,
      cooldownMs: 0,
      retryPolicy: { maxAttempts: 1, delayMs: 0, strategy: 'fixed' },
    },
    source: { id: 'source-schedule', kind: 'schedule', label: 'schedule', enabled: true, createdAt: now - 20_000, updatedAt: now - 20_000, metadata: {} },
    nextRunAt: now + 60_000,
    runCount: 1,
    failureCount: 0,
    successCount: 0,
    deleteAfterRun: false,
    ...overrides,
  };
}

export function baseRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  const now = Date.now();
  return {
    id: 'run-nightly',
    labels: [],
    createdAt: now - 5_000,
    updatedAt: now - 1_000,
    jobId: 'job-nightly',
    status: 'running',
    agentId: 'agent-nightly',
    triggeredBy: { id: 'source-schedule', kind: 'schedule', label: 'schedule', enabled: true, createdAt: now - 20_000, updatedAt: now - 20_000, metadata: {} },
    target: { kind: 'isolated' },
    execution: { target: { kind: 'isolated' }, modelId: 'gpt-test', toolAllowlist: ['read'], timeoutMs: 10_000 },
    scheduleKind: 'cron',
    queuedAt: now - 5_000,
    startedAt: now - 4_500,
    forceRun: true,
    dueRun: false,
    attempt: 1,
    routeId: 'route-slack',
    deliveryIds: ['delivery-1'],
    ...overrides,
  };
}

export function baseRoute(overrides: Partial<AutomationRouteBinding> = {}): AutomationRouteBinding {
  const now = Date.now();
  return {
    id: 'route-slack',
    kind: 'thread',
    surfaceKind: 'slack',
    surfaceId: 'team-1',
    externalId: 'C123',
    threadId: 'T123',
    channelId: 'C123',
    sessionId: 'session-shared',
    title: 'build-alerts',
    lastSeenAt: now - 1_000,
    createdAt: now - 20_000,
    updatedAt: now - 1_000,
    metadata: { responseUrl: 'https://hooks.slack.com/x' },
    ...overrides,
  };
}

export function baseDelivery(overrides: Partial<AutomationDeliveryAttempt> = {}): AutomationDeliveryAttempt {
  return {
    id: 'delivery-1',
    runId: 'run-nightly',
    jobId: 'job-nightly',
    target: { kind: 'surface', surfaceKind: 'slack', routeId: 'route-slack', label: 'slack thread' },
    status: 'sent',
    startedAt: Date.now() - 1_000,
    endedAt: Date.now() - 500,
    responseId: 'msg-1',
    ...overrides,
  };
}

export function baseWatcher(overrides: Partial<WatcherRecord> = {}): WatcherRecord {
  const now = Date.now();
  return {
    id: 'watcher-fs',
    kind: 'filesystem',
    label: 'Filesystem Watcher',
    state: 'degraded',
    source: { id: 'source-watch', kind: 'watcher', label: 'fs', enabled: true, createdAt: now - 20_000, updatedAt: now - 2_000, metadata: {} },
    lastHeartbeatAt: now - 4_000,
    sourceLagMs: 15_000,
    sourceStatus: 'lagging',
    degradedReason: 'source behind expected heartbeat',
    metadata: {},
    ...overrides,
  };
}

export function baseClient(overrides: Partial<ControlPlaneClientRecord> = {}): ControlPlaneClientRecord {
  const now = Date.now();
  return {
    id: 'client-web',
    kind: 'web',
    label: 'Web Console',
    transport: 'sse',
    connected: true,
    sessionId: 'session-shared',
    routeId: 'route-slack',
    authenticatedAt: now - 10_000,
    lastSeenAt: now - 500,
    capabilities: ['events', 'approvals', 'sessions'],
    metadata: { userId: 'operator' },
    ...overrides,
  };
}

/** Shared beforeEach body for the control-plane operator panel suites. Returns the tmpdir root. */
export function setupControlPlaneBrokers(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'gv-control-plane-panels-'));
  (ApprovalBroker as unknown as { instance: ApprovalBroker | null }).instance = new ApprovalBroker({
    store: new PersistentStore(join(root, 'approvals.json')),
  });
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore(join(root, 'routes.json')),
  });
  (SharedSessionBroker as unknown as { instance: SharedSessionBroker | null }).instance = new SharedSessionBroker({
    store: new PersistentStore(join(root, 'sessions.json')) as never,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  });
  return { root };
}

/** Shared afterEach body for the control-plane operator panel suites. */
export function teardownControlPlaneBrokers(root: string): void {
  resetTestRuntimeServices();
  resetTestRuntimeServices();
  rmSync(root, { recursive: true, force: true });
}
