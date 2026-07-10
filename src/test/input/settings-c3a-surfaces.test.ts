/**
 * Task 6: the new C3a config surfaces must be reachable through the settings
 * modal — permissions.backgroundAgents and diagnostics.postEdit. The
 * diagnostics category was previously unregistered, so its key was silently
 * dropped from buildSettingGroups; this pins that it now surfaces.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { SETTINGS_CATEGORIES } from '../../input/settings-modal-types.ts';

const dirs: string[] = [];
function makeConfig(): ConfigManager {
  const root = join(tmpdir(), `gv-c3a-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  dirs.push(root);
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-tui'),
  });
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('settings C3a surfaces', () => {
  test("'diagnostics' is a registered settings category", () => {
    expect(SETTINGS_CATEGORIES).toContain('diagnostics');
  });

  test('diagnostics.postEdit surfaces under the diagnostics category (was previously dropped)', () => {
    const groups = buildSettingGroups(makeConfig());
    const diagnostics = groups.get('diagnostics') ?? [];
    const keys = diagnostics.map((e) => e.setting.key);
    expect(keys).toContain('diagnostics.postEdit');
    const entry = diagnostics.find((e) => e.setting.key === 'diagnostics.postEdit')!;
    expect(entry.setting.type).toBe('enum');
    expect(entry.setting.enumValues).toEqual(['on', 'off']);
  });

  test('permissions.backgroundAgents surfaces under the permissions category', () => {
    const groups = buildSettingGroups(makeConfig());
    const permissions = groups.get('permissions') ?? [];
    const keys = permissions.map((e) => e.setting.key);
    expect(keys).toContain('permissions.backgroundAgents');
    const entry = permissions.find((e) => e.setting.key === 'permissions.backgroundAgents')!;
    expect(entry.setting.enumValues).toEqual(['inherit', 'allow-all']);
  });
});
