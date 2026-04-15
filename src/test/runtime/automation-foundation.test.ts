import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../config/manager.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createFeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';

describe('automation/control-plane foundation', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-automation-foundation-'));
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
    const config = new ConfigManager({ configDir });

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

    expect(flags.isEnabled('automation-runtime')).toBe(false);
    expect(flags.isEnabled('gateway-control-plane')).toBe(false);

    flags.loadFromConfig({
      flags: {
        'automation-runtime': 'enabled',
        'gateway-control-plane': 'enabled',
        'omnichannel-route-binding': 'enabled',
      },
    });

    expect(flags.isEnabled('automation-runtime')).toBe(true);
    expect(flags.isEnabled('gateway-control-plane')).toBe(true);
    expect(flags.isEnabled('omnichannel-route-binding')).toBe(true);
  });
});
