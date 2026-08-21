import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationDeliveryManager } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationRun } from '@pellux/goodvibes-sdk/platform/automation';
import { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation';
import type { AutomationSourceRecord } from '@pellux/goodvibes-sdk/platform/automation';
import { RouteBindingManager } from '@pellux/goodvibes-sdk/platform/channels';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ServiceRegistry } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import { RuntimeEventBus, createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import type { DeliveryEvent } from '@/runtime/index.ts';
import type { RouteEvent } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('surface domain consistency', () => {
  let root = '';

  beforeEach(() => {
    root = makeProjectTempDir('gv-surface-domain');
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
    // One secrets manager for both: the registry resolves service credentials
    // with it, and the delivery manager needs the same one to build a router
    // that can resolve a goodvibes://secrets/... reply credential. Without it
    // a surface accepts replies and silently never sends them, which is why
    // the SDK refuses to construct the manager at all.
    const secretsManager = new SecretsManager({ projectRoot: root, globalHome: root });
    const manager = new AutomationDeliveryManager({
      configManager: new ConfigManager({ surfaceRoot: 'tui',  configDir: root }),
      serviceRegistry: new ServiceRegistry(join(root, 'services.json'), {
        secretsManager,
        subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
      }),
      secretsManager,
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

  // ---------------------------------------------------------------------------
  // integrations.deliveryTracking, driven to BOTH values through the real gate.
  //
  // This is the worst case in the sweep: services.ts built its
  // AutomationDeliveryManager without a featureFlags manager, and
  // isFeatureGateEnabled is permissive when no manager is wired, so a
  // composition root that omitted featureFlags did not disable delivery when
  // integrations.deliveryTracking was turned off, deliverText kept running
  // either way, and this key has no other reader anywhere that could catch
  // the gap. services.ts now threads featureFlags, the same shape as the
  // RouteBindingManager fix.
  //
  // The mutation check for this row: remove that argument and the "off" half
  // of the first test below fails, because the manager falls back to
  // permissive and attempts delivery anyway.
  // ---------------------------------------------------------------------------

  describe('integrations.deliveryTracking feature gate', () => {
    function deliveryManagerWithGate(deliveryRoot: string, enabled: boolean): AutomationDeliveryManager {
      const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: deliveryRoot });
      configManager.set('integrations.deliveryTracking', enabled);
      const featureFlags = createFeatureFlagManager();
      featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
      const routeBindings = new RouteBindingManager({
        store: new AutomationRouteStore(join(deliveryRoot, 'routes.json')),
      });
      const secretsManager = new SecretsManager({ projectRoot: deliveryRoot, globalHome: deliveryRoot });
      // Constructed exactly as runtime/services.ts constructs it.
      return new AutomationDeliveryManager({
        configManager,
        serviceRegistry: new ServiceRegistry(join(deliveryRoot, 'services.json'), {
          secretsManager,
          subscriptionManager: new SubscriptionManager(join(deliveryRoot, 'subscriptions.json')),
        }),
        secretsManager,
        artifactStore: new ArtifactStore({ rootDir: join(deliveryRoot, 'artifacts') }),
        routeBindings,
        featureFlags,
      });
    }

    function gateJobAndRun(): { job: AutomationJob; run: AutomationRun } {
      const source: AutomationSourceRecord = {
        id: 'source-gate',
        kind: 'surface',
        label: 'Gate surface',
        surfaceKind: 'service',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
      };
      const job: AutomationJob = {
        id: 'job-gate',
        labels: [],
        createdAt: 1,
        updatedAt: 1,
        name: 'Gate delivery',
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
        id: 'run-gate',
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
      return { job, run };
    }

    test('integrations.deliveryTracking false turns delivery off entirely', async () => {
      const deliveryRoot = makeProjectTempDir('gv-delivery-gate-off');
      const manager = deliveryManagerWithGate(deliveryRoot, false);
      const { job, run } = gateJobAndRun();
      const attempts = await manager.deliverText(job, run, 'gate body', [
        { kind: 'surface', surfaceKind: 'service', address: 'daemon-1' },
      ]);
      // The gate refuses before it ever resolves a target or reaches the
      // router, so nothing is attempted at all, not even a failed attempt.
      expect(attempts).toEqual([]);
    });

    test('integrations.deliveryTracking true attempts delivery, and is the shipped default', async () => {
      const deliveryRoot = makeProjectTempDir('gv-delivery-gate-on');
      const manager = deliveryManagerWithGate(deliveryRoot, true);
      const { job, run } = gateJobAndRun();
      const attempts = await manager.deliverText(job, run, 'gate body', [
        { kind: 'surface', surfaceKind: 'service', address: 'daemon-1' },
      ]);
      // Past the gate now: it actually tries (and, with no live route bound,
      // dead-letters), which is the observable difference from being refused
      // outright above.
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe('dead_lettered');

      // The default half: with the key never written, effective behaviour
      // matches true.
      const unsetRoot = makeProjectTempDir('gv-delivery-gate-unset');
      const unsetConfig = new ConfigManager({ surfaceRoot: 'tui', configDir: join(unsetRoot, '.goodvibes', 'unset') });
      expect(unsetConfig.get('integrations.deliveryTracking')).toBe(true);
      const flags = createFeatureFlagManager();
      flags.loadFromConfig({ flags: deriveFeatureStates(unsetConfig) });
      const unsetSecretsManager = new SecretsManager({ projectRoot: unsetRoot, globalHome: unsetRoot });
      const unsetManager = new AutomationDeliveryManager({
        configManager: unsetConfig,
        serviceRegistry: new ServiceRegistry(join(unsetRoot, 'services.json'), {
          secretsManager: unsetSecretsManager,
          subscriptionManager: new SubscriptionManager(join(unsetRoot, 'subscriptions.json')),
        }),
        secretsManager: unsetSecretsManager,
        artifactStore: new ArtifactStore({ rootDir: join(unsetRoot, 'artifacts') }),
        routeBindings: new RouteBindingManager({ store: new AutomationRouteStore(join(unsetRoot, 'routes.json')) }),
        featureFlags: flags,
      });
      const { job: unsetJob, run: unsetRun } = gateJobAndRun();
      const unsetAttempts = await unsetManager.deliverText(unsetJob, unsetRun, 'gate body', [
        { kind: 'surface', surfaceKind: 'service', address: 'daemon-1' },
      ]);
      expect(unsetAttempts).toHaveLength(1);
    });
  });
});
