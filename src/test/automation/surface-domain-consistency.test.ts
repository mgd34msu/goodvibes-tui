import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationDeliveryManager } from '@pellux/goodvibes-sdk/platform/automation/delivery-manager';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation/runs';
import { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation/store/routes';
import type { AutomationSourceRecord } from '@pellux/goodvibes-sdk/platform/automation/sources';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels/route-manager';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config/service-registry';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { DeliveryEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/deliveries';
import type { RouteEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/routes';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('surface domain consistency', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-surface-domain-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('route binding events preserve tui and service surface kinds', async () => {
    const bus = new RuntimeEventBus();
    const seen: RouteEvent[] = [];
    bus.onDomain('routes', (envelope) => seen.push(envelope.payload));
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'routes.json')),
      runtimeBus: bus,
    });

    await routeBindings.upsertBinding({
      kind: 'session',
      surfaceKind: 'service',
      surfaceId: 'surface:daemon',
      externalId: 'daemon-1',
      sessionId: 'session-service',
    });
    await routeBindings.upsertBinding({
      kind: 'session',
      surfaceKind: 'tui',
      surfaceId: 'surface:tui',
      externalId: 'local-tui',
      sessionId: 'session-tui',
    });

    const resolved = routeBindings.resolve('service', 'daemon-1');

    await flushMicrotasks();
    expect(resolved?.sessionId).toBe('session-service');
    expect(seen.some((event) => event.type === 'ROUTE_BINDING_CREATED' && event.surfaceKind === 'service')).toBe(true);
    expect(seen.some((event) => event.type === 'ROUTE_BINDING_CREATED' && event.surfaceKind === 'tui')).toBe(true);
    expect(seen.some((event) => event.type === 'ROUTE_BINDING_RESOLVED' && event.surfaceKind === 'service')).toBe(true);
  });

  test('delivery events preserve first-class service surface kinds', async () => {
    const bus = new RuntimeEventBus();
    const seen: DeliveryEvent[] = [];
    bus.onDomain('deliveries', (envelope) => seen.push(envelope.payload));
    const routeBindings = new RouteBindingManager({
      store: new AutomationRouteStore(join(root, 'delivery-routes.json')),
    });
    const manager = new AutomationDeliveryManager({
      configManager: new ConfigManager({ surfaceRoot: 'tui',  configDir: root }),
      serviceRegistry: new ServiceRegistry(join(root, 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: root, globalHome: root }),
        subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
      }),
      artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
      routeBindings,
      runtimeBus: bus,
    });
    const source: AutomationSourceRecord = {
      id: 'source-service',
      kind: 'surface',
      label: 'Service surface',
      surfaceKind: 'service',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      metadata: {},
    };
    const job: AutomationJob = {
      id: 'job-service',
      labels: [],
      createdAt: 1,
      updatedAt: 1,
      name: 'Service delivery',
      status: 'enabled',
      enabled: true,
      schedule: { kind: 'every', intervalMs: 60_000 },
      execution: { target: { kind: 'background' } },
      delivery: { mode: 'surface', targets: [], fallbackTargets: [], includeSummary: false, includeTranscript: false, includeLinks: false },
      failure: { action: 'retry', maxConsecutiveFailures: 1, cooldownMs: 0, retryPolicy: { maxAttempts: 1, delayMs: 0, strategy: 'fixed' } },
      source,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      deleteAfterRun: false,
    };
    const run: AutomationRun = {
      id: 'run-service',
      labels: [],
      createdAt: 1,
      updatedAt: 1,
      jobId: job.id,
      status: 'running',
      triggeredBy: source,
      target: { kind: 'background' },
      execution: { target: { kind: 'background' } },
      queuedAt: 1,
      forceRun: false,
      dueRun: true,
      attempt: 1,
      deliveryIds: [],
    };

    const attempts = await manager.deliverText(job, run, 'service delivery body', [
      { kind: 'surface', surfaceKind: 'service', address: 'daemon-1' },
    ]);

    expect(attempts[0]?.status).toBe('dead_lettered');
    await flushMicrotasks();
    expect(seen.some((event) => event.type === 'DELIVERY_QUEUED' && event.surfaceKind === 'service')).toBe(true);
    expect(seen.some((event) => event.type === 'DELIVERY_STARTED' && event.surfaceKind === 'service')).toBe(true);
    expect(seen.some((event) => event.type === 'DELIVERY_FAILED' && event.surfaceKind === 'service')).toBe(true);
  });
});
