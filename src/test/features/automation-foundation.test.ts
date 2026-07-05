import { describe, test, expect } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { CONFIG_SCHEMA, DEFAULT_CONFIG, isValidConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_FLAGS } from '@/runtime/index.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-automation-foundation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('automation foundation config surface', () => {
  test('defaults include automation, control plane, web, surfaces, watchers, and service categories', () => {
    const tmpDir = makeTmpDir();
    const configDir = join(tmpDir, '.goodvibes', 'tui');
    const mgr = new ConfigManager({ surfaceRoot: 'tui',  workingDir: tmpDir, configDir });

    expect(mgr.get('automation.enabled')).toBe(false);
    expect(mgr.get('automation.maxConcurrentRuns')).toBe(DEFAULT_CONFIG.automation.maxConcurrentRuns);
    expect(mgr.get('controlPlane.enabled')).toBe(false);
    expect(mgr.get('controlPlane.streamMode')).toBe('sse');
    expect(mgr.get('web.enabled')).toBe(false);
    expect(mgr.get('surfaces.slack.enabled')).toBe(false);
    expect(mgr.get('surfaces.discord.enabled')).toBe(false);
    expect(mgr.get('surfaces.ntfy.baseUrl')).toBe('https://ntfy.sh');
    expect(mgr.get('surfaces.webhook.timeoutMs')).toBe(10_000);
    expect(mgr.get('watchers.enabled')).toBe(false);
    expect(mgr.get('service.autostart')).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('representative automation keys round-trip through ConfigManager', () => {
    const tmpDir = makeTmpDir();
    const configDir = join(tmpDir, '.goodvibes', 'tui');
    const mgr = new ConfigManager({ surfaceRoot: 'tui',  workingDir: tmpDir, configDir });

    mgr.set('automation.enabled', true);
    mgr.set('automation.maxConcurrentRuns', 12);
    mgr.set('controlPlane.port', 4521);
    mgr.set('web.publicBaseUrl', 'http://127.0.0.1:8080');
    mgr.set('surfaces.slack.defaultChannel', 'alerts');
    mgr.set('surfaces.discord.defaultChannelId', '1234567890');
    mgr.set('watchers.pollIntervalMs', 30_000);
    mgr.set('service.platform', 'manual');

    const reloaded = new ConfigManager({ surfaceRoot: 'tui',  workingDir: tmpDir, configDir });
    expect(reloaded.get('automation.enabled')).toBe(true);
    expect(reloaded.get('automation.maxConcurrentRuns')).toBe(12);
    expect(reloaded.get('controlPlane.port')).toBe(4521);
    expect(reloaded.get('web.publicBaseUrl')).toBe('http://127.0.0.1:8080');
    expect(reloaded.get('surfaces.slack.defaultChannel')).toBe('alerts');
    expect(reloaded.get('surfaces.discord.defaultChannelId')).toBe('1234567890');
    expect(reloaded.get('watchers.pollIntervalMs')).toBe(30_000);
    expect(reloaded.get('service.platform')).toBe('manual');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('project config deep-merges new nested categories', () => {
    const tmpDir = makeTmpDir();
    const settingsDir = join(tmpDir, '.goodvibes', 'tui');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, 'settings.json'),
      JSON.stringify({
        automation: { maxConcurrentRuns: 2 },
        controlPlane: { enabled: true, port: 5123 },
        surfaces: { ntfy: { enabled: true, topic: 'goodvibes' } },
        watchers: { enabled: true, heartbeatIntervalMs: 5000 },
        service: { enabled: true, autostart: true },
      }, null, 2),
      'utf-8',
    );

    const mgr = new ConfigManager({ surfaceRoot: 'tui',  workingDir: tmpDir, configDir: settingsDir });
    expect(mgr.get('automation.maxConcurrentRuns')).toBe(2);
    expect(mgr.get('controlPlane.enabled')).toBe(true);
    expect(mgr.get('controlPlane.port')).toBe(5123);
    expect(mgr.get('surfaces.ntfy.enabled')).toBe(true);
    expect(mgr.get('surfaces.ntfy.topic')).toBe('goodvibes');
    expect(mgr.get('watchers.enabled')).toBe(true);
    expect(mgr.get('watchers.heartbeatIntervalMs')).toBe(5000);
    expect(mgr.get('service.enabled')).toBe(true);
    expect(mgr.get('service.autostart')).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('schema includes the new additive config keys', () => {
    const keys = new Set(CONFIG_SCHEMA.map((entry) => entry.key));
    const expected = [
      'automation.enabled',
      'automation.maxConcurrentRuns',
      'controlPlane.enabled',
      'controlPlane.port',
      'controlPlane.streamMode',
      'web.enabled',
      'web.publicBaseUrl',
      'surfaces.slack.enabled',
      'surfaces.discord.enabled',
      'surfaces.ntfy.enabled',
      'surfaces.webhook.enabled',
      'watchers.enabled',
      'service.enabled',
      'service.platform',
    ] as const;

    for (const key of expected) {
      expect(keys.has(key)).toBe(true);
      expect(isValidConfigKey(key)).toBe(true);
    }
  });
});

describe('automation foundation feature flags', () => {
  test('new automation and omnichannel flags are declared with their documented defaults', () => {
    const expected = [
      'automation-domain',
      'control-plane-gateway',
      'route-binding',
      'delivery-engine',
      'slack-surface',
      'discord-surface',
      'ntfy-surface',
      'webhook-surface',
      'web-surface',
      'watcher-framework',
      'service-management',
    ] as const;

    // One-Platform Wave 1: control-plane-gateway is the single tier-10 flag that
    // defaults ON (a stock daemon must serve its auth-gated streams). Every other
    // omnichannel/automation flag stays OFF until individually validated.
    const enabledByDefault = new Set<string>(['control-plane-gateway']);

    for (const id of expected) {
      const flag = FEATURE_FLAGS.find((entry) => entry.id === id);
      expect(flag).toBeDefined();
      expect(flag?.defaultState).toBe(enabledByDefault.has(id) ? 'enabled' : 'disabled');
    }
  });
});
