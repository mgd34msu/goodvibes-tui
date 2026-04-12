import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { AutomationControlPanel } from '../../panels/automation-control-panel.ts';
import { RoutesPanel } from '../../panels/routes-panel.ts';
import { WatchersPanel } from '../../panels/watchers-panel.ts';
import { ControlPlanePanel } from '../../panels/control-plane-panel.ts';
import { ApprovalBroker, SharedSessionBroker, ControlPlaneGateway } from '../../control-plane/index.ts';
import type { PermissionPromptRequest } from '../../permissions/prompt.ts';
import type { AutomationJob } from '../../automation/jobs.ts';
import type { AutomationRun } from '../../automation/runs.ts';
import type { AutomationRouteBinding } from '../../automation/routes.ts';
import { AutomationRouteStore } from '../../automation/store/routes.ts';
import { RouteBindingManager } from '../../channels/route-manager.ts';
import type { AutomationDeliveryAttempt } from '../../automation/delivery.ts';
import type { WatcherRecord } from '../../runtime/store/domains/watchers.ts';
import type { ControlPlaneClientRecord } from '../../runtime/store/domains/control-plane.ts';
import { PersistentStore } from '../../state/persistent-store.ts';
import { getTestApprovalBroker, getTestSessionBroker, resetTestRuntimeServices } from '../helpers/runtime-services.ts';

function linesText(lines: ReturnType<AutomationControlPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function baseJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
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

function baseRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
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

function baseRoute(overrides: Partial<AutomationRouteBinding> = {}): AutomationRouteBinding {
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

function baseDelivery(overrides: Partial<AutomationDeliveryAttempt> = {}): AutomationDeliveryAttempt {
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

function baseWatcher(overrides: Partial<WatcherRecord> = {}): WatcherRecord {
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

function baseClient(overrides: Partial<ControlPlaneClientRecord> = {}): ControlPlaneClientRecord {
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

describe('control-plane operator panels', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-control-plane-panels-'));
    (ApprovalBroker as unknown as { instance: ApprovalBroker | null }).instance = new ApprovalBroker(
      new PersistentStore(join(root, 'approvals.json')) as never,
    );
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'routes.json')),
    });
    (SharedSessionBroker as unknown as { instance: SharedSessionBroker | null }).instance = new SharedSessionBroker({
      store: new PersistentStore(join(root, 'sessions.json')) as never,
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
  });

  afterEach(() => {
    resetTestRuntimeServices();
    resetTestRuntimeServices();
    rmSync(root, { recursive: true, force: true });
  });

  test('AutomationControlPanel renders jobs, runs, and delivery posture', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncAutomationJob(baseJob(), 'test');
    dispatch.syncAutomationRun(baseRun(), 'test');
    dispatch.syncDeliveryAttempt(baseDelivery(), 'test');

    const panel = new AutomationControlPanel(store);
    const text = linesText(panel.render(100, 28));
    expect(text).toContain('Automation Control');
    expect(text).toContain('Nightly Sweep');
    expect(text).toContain('running');
    expect(text).toContain('deliveries ok');
  });

  test('RoutesPanel renders bound surface/session context', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRouteBinding(baseRoute(), 'test');

    const panel = new RoutesPanel(store);
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Route Bindings');
    expect(text).toContain('slack');
    expect(text).toContain('session-shared');
    expect(text).toContain('build-alerts');
  });

  test('WatchersPanel renders degraded watcher state and lag', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncWatcher(baseWatcher(), 'test');

    const panel = new WatchersPanel(store);
    const text = linesText(panel.render(100, 26));
    expect(text).toContain('Watchers');
    expect(text).toContain('Filesystem Watcher');
    expect(text).toContain('lagging');
    expect(text).toContain('source behind expected heartbeat');
  });

  test('ControlPlanePanel renders clients, approvals, sessions, and recent events', async () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      host: '127.0.0.1',
      port: 3421,
      connectionState: 'connected',
      requestCount: 14,
      errorCount: 1,
    }, 'test');
    dispatch.syncControlPlaneClient(baseClient(), 'test');

    const gateway = new ControlPlaneGateway({ runtimeStore: store, server: { enabled: true, host: '127.0.0.1', port: 3421 } });
    gateway.publishEvent('session-update', { sessionId: 'session-shared', status: 'open' });

    const sessionBroker = getTestSessionBroker();
    await sessionBroker.start();
    await sessionBroker.createSession({
      id: 'session-shared',
      title: 'Shared session',
      participant: {
        surfaceKind: 'web',
        surfaceId: 'web-console',
        externalId: 'session-shared',
        displayName: 'web console',
        lastSeenAt: Date.now(),
      },
    });

    const broker = getTestApprovalBroker();
    const request: PermissionPromptRequest = {
      callId: 'call-approval-1',
      tool: 'exec',
      args: { cmd: 'git status' },
      category: 'execute',
      analysis: {
        classification: 'execute',
        riskLevel: 'high',
        summary: 'Review git status execution',
        reasons: ['Shell execution from an external approval path.'],
        target: 'git status',
        targetKind: 'command',
      },
    };
    void broker.requestApproval({
      sessionId: 'session-shared',
      routeId: 'route-slack',
      request,
      localPrompt: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const panel = new ControlPlanePanel(store, {
      approvalBroker: broker,
      sessionBroker,
      getRecentEvents: (limit) => gateway.listRecentEvents(limit),
    });
    const text = linesText(panel.render(110, 30));
    expect(text).toContain('Control Plane');
    expect(text).toContain('Web Console');
    expect(text).toContain('exec');
    expect(text).toContain('Shared session');
    expect(text).toContain('session-update');
  });
});
