import { describe, test, expect, afterEach } from 'bun:test';
import { rmSync } from 'node:fs';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { getSettingLabel } from '../../renderer/settings-modal-helpers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

function makeConfig(): ConfigManager {
  const dir = makeProjectTempDir('gv-blocked-esc');
  roots.push(dir);
  return new ConfigManager({ workingDir: dir, homeDir: dir, surfaceRoot: 'tui' });
}

const KEYS: readonly ConfigKey[] = [
  'notifications.blockedEscalationGraceMs',
  'notifications.blockedEscalationFollowUpMs',
  'notifications.blockedEscalationMaxFollowUps',
];

describe('blocked-too-long escalation settings surface', () => {
  test('all three keys land in the notifications settings domain, from the SDK schema', () => {
    const groups = buildSettingGroups(makeConfig());
    const notifications = groups.get('notifications') ?? [];
    const keysInDomain = new Set(notifications.map((e) => e.setting.key));
    for (const key of KEYS) expect(keysInDomain.has(key)).toBe(true);
  });

  test('they carry real numeric option shapes (typed, with min/max ranges)', () => {
    const groups = buildSettingGroups(makeConfig());
    const notifications = groups.get('notifications') ?? [];
    for (const key of KEYS) {
      const entry = notifications.find((e) => e.setting.key === key);
      expect(entry).toBeDefined();
      expect(entry!.setting.type).toBe('number');
      // The schema attaches a bounded integer range (validate + hint), not a
      // free-form field.
      expect((entry!.setting as { validationHint?: string }).validationHint).toContain('integer in [');
      expect(typeof (entry!.setting as { validate?: unknown }).validate).toBe('function');
    }
  });

  test('each key has a plain-language label (not the raw key fallback)', () => {
    const groups = buildSettingGroups(makeConfig());
    const notifications = groups.get('notifications') ?? [];
    for (const key of KEYS) {
      const entry = notifications.find((e) => e.setting.key === key)!;
      const label = getSettingLabel(entry);
      expect(label).toContain('Blocked');
      expect(label).not.toBe(key);
    }
  });
});
