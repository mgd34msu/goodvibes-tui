import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createFeatureFlagManager, RuntimeEventBus, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('automation/control-plane foundation', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = makeProjectTempDir('gv-automation-foundation');
    configDir = join(root, '.goodvibes', 'tui');
  });

  afterEach(() => {
    configDir = '';
  });

  test('initial runtime store includes automation, routes, control-plane, and watcher domains', () => {
    const store = createRuntimeStore();
    const state = store.getState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);
    expect(state.routes.bindingIds).toEqual([]);
    expect(state.controlPlane.connectionState).toBe('disabled');
  });

  test('config manager supports deep surface settings and reset for nested keys', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir });

    expect(config.get('surfaces.slack.enabled')).toBe(false);
    expect(config.get('automation.maxConcurrentRuns')).toBe(4);

    config.set('surfaces.slack.enabled', true);
    config.set('surfaces.discord.applicationId', 'discord-app');
    config.set('automation.maxConcurrentRuns', 9);

    expect(config.get('surfaces.slack.enabled')).toBe(true);
    expect(config.get('surfaces.discord.applicationId')).toBe('discord-app');
    expect(config.get('automation.maxConcurrentRuns')).toBe(9);

    config.reset('surfaces.slack.enabled');
    config.reset('surfaces.discord.applicationId');
    config.reset('automation.maxConcurrentRuns');

    expect(config.get('surfaces.slack.enabled')).toBe(false);
    expect(config.get('surfaces.discord.applicationId')).toBe('');
    expect(config.get('automation.maxConcurrentRuns')).toBe(4);
  });

  test('feature flag manager registers automation and gateway cutover flags', () => {
    const flags = createFeatureFlagManager();

    // Both capabilities ship ON in a stock configuration under the dissolved
    // feature model (automation.enabled / controlPlane.gateway govern them).
    expect(flags.isEnabled('automation-domain')).toBe(true);
    expect(flags.isEnabled('control-plane-gateway')).toBe(true);

    flags.loadFromConfig({
      flags: {
        'automation-domain': 'enabled',
        'control-plane-gateway': 'enabled',
        'route-binding': 'enabled',
      },
    });

    expect(flags.isEnabled('automation-domain')).toBe(true);
    expect(flags.isEnabled('control-plane-gateway')).toBe(true);
    expect(flags.isEnabled('route-binding')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runtime.eventBus.maxListeners, threaded into a bus built with no options,
// the same way every composition root in this project now calls it
// (bundle-command.ts, management-utils.ts, daemon/cli.ts, bootstrap-core.ts):
// `configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) =>
// configManager.get(key)))` right before the first `new RuntimeEventBus()`.
//
// Before this sweep, none of the four called it: the schema promised a
// tunable listener cap and every bus in this project was built with no
// options, so the cap was always the SDK's hardcoded 100 regardless of the
// setting. This proves the exact call shape used at all four sites reaches
// a freshly-built bus, in both directions (a lower cap refuses sooner, a
// higher cap accepts more).
// ---------------------------------------------------------------------------

describe('runtime.eventBus.maxListeners reaches a bus built with no options', () => {
  let origEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    tmpRoot = makeProjectTempDir('gv-event-bus-cap');
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    // Leave the process-wide default where the rest of the suite expects it.
    configureRuntimeEventBusDefaults({ maxListeners: 100 });
  });

  function configManagerWithCap(cap: number): ConfigManager {
    const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(tmpRoot, `config-${cap}`) });
    manager.set('runtime.eventBus.maxListeners', cap);
    return manager;
  }

  test('a configured cap of 4 refuses the 5th listener on a bus built after the call', () => {
    const configManager = configManagerWithCap(4);
    // The exact call shape used at every composition-root site in this project.
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => configManager.get(key)));

    const bus = new RuntimeEventBus();
    for (let i = 0; i < 4; i++) {
      bus.on('SESSION_STARTED', (() => {}) as Parameters<typeof bus.on>[1]);
    }
    expect(() => {
      bus.on('SESSION_STARTED', (() => {}) as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });

  test('a configured cap of 40 accepts a 5th listener and refuses the 41st', () => {
    const configManager = configManagerWithCap(40);
    configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => configManager.get(key)));

    const bus = new RuntimeEventBus();
    // The count the previous case refused is fine at this cap.
    expect(() => {
      for (let i = 0; i < 5; i++) bus.on('SESSION_STARTED', (() => {}) as Parameters<typeof bus.on>[1]);
    }).not.toThrow();
    for (let i = 0; i < 35; i++) bus.on('SESSION_STARTED', (() => {}) as Parameters<typeof bus.on>[1]);
    expect(() => {
      bus.on('SESSION_STARTED', (() => {}) as Parameters<typeof bus.on>[1]);
    }).toThrow(RangeError);
  });
});
