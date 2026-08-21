/**
 * daemon-owned-config-migration.test.ts
 *
 * Daemon-owned configuration now has exactly one home:
 * `~/.goodvibes/daemon/settings.json` (SDK, `platform/config`'s
 * `migrateDaemonOwnedConfig`). Before this migration, a value like
 * `surfaces.telegram.botToken` written into `~/.goodvibes/tui/settings.json`
 * looked like any other TUI-local setting but the daemon, the only process
 * that actually reads `surfaces.*`, never saw it. This proves, against a
 * real temp home directory (never a fake): the migration helper this repo
 * wraps around the SDK's function runs and is idempotent, a TUI `ConfigManager`
 * resolves the moved keys from the daemon tier afterward, and a client-owned
 * key (`display.theme`) is left alone in the surface file.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, daemonConfigPath } from '@pellux/goodvibes-sdk/platform/config';
import { runDaemonConfigMigration } from '../../config/run-daemon-config-migration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
function home(): string {
  const dir = makeProjectTempDir('gv-daemon-config-migration');
  roots.push(dir);
  return dir;
}

function tuiSettingsPath(h: string): string {
  return join(h, '.goodvibes', 'tui', 'settings.json');
}

function writeTuiSettings(h: string, contents: Record<string, unknown>): void {
  const path = tuiSettingsPath(h);
  mkdirSync(join(h, '.goodvibes', 'tui'), { recursive: true });
  writeFileSync(path, JSON.stringify(contents, null, 2));
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runDaemonConfigMigration', () => {
  test('moves surfaces.telegram.* out of tui/settings.json into the daemon store, and is idempotent', () => {
    const h = home();
    writeTuiSettings(h, {
      surfaces: {
        telegram: {
          enabled: true,
          botToken: 'test-bot-token-12345',
          defaultChatId: 'chat-9',
        },
      },
      display: { theme: 'dark' },
    });

    const first = runDaemonConfigMigration(h);
    expect(first).not.toBeNull();
    expect(first!.migrated).toBe(true);
    const movedKeys = first!.marker.moved.map((entry) => entry.key).sort();
    expect(movedKeys).toEqual(['surfaces.telegram.botToken', 'surfaces.telegram.defaultChatId', 'surfaces.telegram.enabled']);

    // The daemon store now carries the moved values.
    const storePath = daemonConfigPath(h);
    expect(existsSync(storePath)).toBe(true);
    const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      surfaces?: { telegram?: { enabled?: boolean; botToken?: string; defaultChatId?: string } };
    };
    expect(store.surfaces?.telegram?.enabled).toBe(true);
    expect(store.surfaces?.telegram?.botToken).toBe('test-bot-token-12345');
    expect(store.surfaces?.telegram?.defaultChatId).toBe('chat-9');

    // The surface file no longer carries the daemon-owned keys, but the
    // client-owned key it also held is left untouched.
    const surface = JSON.parse(readFileSync(tuiSettingsPath(h), 'utf-8')) as {
      surfaces?: { telegram?: unknown };
      display?: { theme?: string };
    };
    expect(surface.surfaces?.telegram).toBeUndefined();
    expect(surface.display?.theme).toBe('dark');

    // Idempotent: a second call is a no-op (already migrated), same marker path.
    const second = runDaemonConfigMigration(h);
    expect(second).not.toBeNull();
    expect(second!.migrated).toBe(false);
    expect(second!.markerPath).toBe(first!.markerPath);
    expect(second!.marker.moved.map((entry) => entry.key).sort()).toEqual(movedKeys);

    // A third call after re-writing the (now-empty) surface file's daemon
    // keys is still a no-op, the marker, not file contents, is authoritative.
    const third = runDaemonConfigMigration(h);
    expect(third!.migrated).toBe(false);
  });

  test('a ConfigManager rooted at "tui" resolves migrated daemon-owned keys from the daemon tier', () => {
    const h = home();
    writeTuiSettings(h, {
      surfaces: { telegram: { enabled: true, botToken: 'resolve-me-token' } },
    });
    const result = runDaemonConfigMigration(h);
    expect(result!.migrated).toBe(true);

    const cm = new ConfigManager({ homeDir: h, workingDir: h, surfaceRoot: 'tui' });
    expect(cm.get('surfaces.telegram.enabled')).toBe(true);
    expect(cm.get('surfaces.telegram.botToken')).toBe('resolve-me-token');

    const enabledSource = cm.describeConfigKeySource('surfaces.telegram.enabled');
    expect(enabledSource.tier).toBe('daemon');
    expect(enabledSource.daemonOwned).toBe(true);
    expect(enabledSource.daemonTierPath).toBe(cm.getDaemonTierPath());
    expect(cm.getDaemonTierPath()).toBe(daemonConfigPath(h));

    const tokenSource = cm.describeConfigKeySource('surfaces.telegram.botToken');
    expect(tokenSource.tier).toBe('daemon');
    expect(tokenSource.daemonOwned).toBe(true);
  });

  test('a client-owned key (display.theme) still resolves from the surface file, untouched by migration', () => {
    const h = home();
    writeTuiSettings(h, {
      surfaces: { telegram: { enabled: true } },
      display: { theme: 'dark' },
    });
    const result = runDaemonConfigMigration(h);
    expect(result!.migrated).toBe(true);

    const cm = new ConfigManager({ homeDir: h, workingDir: h, surfaceRoot: 'tui' });
    expect(cm.get('display.theme')).toBe('dark');

    const themeSource = cm.describeConfigKeySource('display.theme');
    expect(themeSource.tier).not.toBe('daemon');
    expect(themeSource.daemonOwned).toBe(false);

    // Setting it again writes back to the surface file, not the daemon store.
    cm.set('display.theme', 'light');
    const surface = JSON.parse(readFileSync(tuiSettingsPath(h), 'utf-8')) as { display?: { theme?: string } };
    expect(surface.display?.theme).toBe('light');
    const storePath = daemonConfigPath(h);
    if (existsSync(storePath)) {
      const store = JSON.parse(readFileSync(storePath, 'utf-8')) as { display?: { theme?: string } };
      expect(store.display?.theme).not.toBe('light');
    }
  });
});
