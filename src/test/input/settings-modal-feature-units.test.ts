/**
 * Feature-unit presentation in the settings modal.
 *
 * Every platform capability renders as ONE unit in its settings DOMAIN, the
 * feature's real enablement row as a named header plus the settings keys that
 * tune it, sourced from the SDK's FEATURE_SETTINGS surface. This locks:
 *   - every feature is reachable in the settings structure;
 *   - a header IS the real config row for its enablement key (boolean toggle
 *     or enum mode choices), never a synthetic key;
 *   - features sharing one enablement key each keep their own header;
 *   - a feature's settings keys sit under its header, not double-listed as
 *     orphans;
 *   - the separate feature-flag grouping is gone from the category rail.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS, deriveFeatureStates } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { getFeatureUnitHostCategory } from '../../input/feature-unit-layout.ts';
import { SETTINGS_CATEGORIES } from '../../input/settings-modal-types.ts';
import type { SettingEntry, SettingsCategory } from '../../input/settings-modal-types.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-feature-units-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every enablement key in the feature surface (some are shared by two features). */
const ENABLEMENT_KEYS = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));

describe('settings modal: feature units', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;
  let ffm: FeatureFlagManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = new ConfigManager({ surfaceRoot: 'tui', workingDir: tmpDir, homeDir: tmpDir, configDir: join(tmpDir, '.goodvibes', 'global-tui') });
    ffm = createFeatureFlagManager();
    ffm.loadFromConfig({ flags: deriveFeatureStates(cm) });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function collectHeaders(groups: Map<SettingsCategory, SettingEntry[]>): Map<string, { category: SettingsCategory; entry: SettingEntry }> {
    const headers = new Map<string, { category: SettingsCategory; entry: SettingEntry }>();
    for (const [category, entries] of groups) {
      for (const entry of entries) {
        if (entry.flag) headers.set(entry.flag.feature.id, { category, entry });
      }
    }
    return headers;
  }

  test('the separate feature-flag grouping is gone from the category rail', () => {
    expect((SETTINGS_CATEGORIES as readonly string[]).includes('flags')).toBe(false);
  });

  test('every capability is reachable as a unit header in the settings structure', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);
    for (const feature of FEATURE_SETTINGS) {
      expect(headers.has(feature.id)).toBe(true);
    }
    // Exactly one header per feature, features sharing an enablement key
    // (both compaction strategies, both telemetry modes) each keep their own.
    let headerCount = 0;
    for (const entries of groups.values()) headerCount += entries.filter((e) => e.flag).length;
    expect(headerCount).toBe(FEATURE_SETTINGS.length);
  });

  test('each feature unit is hosted in its settings domain', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);
    for (const feature of FEATURE_SETTINGS) {
      const placed = headers.get(feature.id)!;
      expect(placed.category).toBe(feature.domain as SettingsCategory);
      const hostCategory = getFeatureUnitHostCategory(feature.id);
      expect(hostCategory).not.toBeNull();
      expect(placed.category).toBe(hostCategory!);
    }
  });

  test('a header is the REAL config row for its enablement key, with its real option shape', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);

    // Boolean enablement: control-plane-gateway rides controlPlane.gateway.
    const cpg = headers.get('control-plane-gateway')!.entry;
    expect(cpg.setting.key).toBe('controlPlane.gateway');
    expect(cpg.setting.type).toBe('boolean');
    expect(cpg.currentValue).toBe(true); // defaults on
    expect(cpg.isDefault).toBe(true);
    expect(cpg.flag!.state).toBe('enabled');

    // Enum enablement: the header row carries the schema's mode choices.
    const compaction = headers.get('session-compaction')!.entry;
    expect(compaction.setting.key).toBe('behavior.compactionStrategy');
    expect(compaction.setting.type).toBe('enum');
    expect((compaction.setting.enumValues ?? []).length).toBeGreaterThan(1);

    // Shared enablement key: the distiller feature has its OWN header over the
    // same row, and its state derives from its own active values.
    const distiller = headers.get('compaction-distiller-strategy')!.entry;
    expect(distiller.setting.key).toBe('behavior.compactionStrategy');
    expect(distiller.flag!.feature.id).toBe('compaction-distiller-strategy');
    expect(distiller.flag!.state).toBe('disabled'); // stock value is 'structured'
    expect(compaction.flag!.state).toBe('enabled');
  });

  test("a feature's settings keys sit under its header and are not double-listed as orphan rows", () => {
    const groups = buildSettingGroups(cm, ffm);
    // Keys owned by SOME feature (excluding enablement keys, which are headers).
    const ownedKeys = new Set<string>();
    for (const feature of FEATURE_SETTINGS) {
      for (const key of feature.settings) {
        if (!ENABLEMENT_KEYS.has(key)) ownedKeys.add(key);
      }
    }

    // Within each key's HOME (namespace) category, an owned key appears exactly
    // once, as a sub-option under its unit, never as an un-owned orphan row.
    // The 'network' category is a deliberate combined cross-list view of
    // controlPlane/httpListener/web keys; it is not any key's home category,
    // so it is excluded from the double-listing rule.
    const seen = new Map<string, number>();
    for (const [category, entries] of groups) {
      if (category === 'network') continue;
      for (const entry of entries) {
        if (entry.flag) continue; // header row
        if (!ownedKeys.has(entry.setting.key)) continue;
        expect(entry.ownerFlagId).toBeDefined();
        seen.set(entry.setting.key, (seen.get(entry.setting.key) ?? 0) + 1);
      }
    }
    for (const key of ownedKeys) {
      expect(seen.get(key) ?? 0).toBeLessThanOrEqual(1);
    }

    // Spot-check a representative unit: exec-sandbox rides sandbox.enabled and
    // its tuning keys render directly after the header in the sandbox domain.
    const sandbox = groups.get('sandbox') ?? [];
    const headerIdx = sandbox.findIndex((e) => e.flag?.feature.id === 'exec-sandbox');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sandbox[headerIdx]!.setting.key).toBe('sandbox.enabled');
    const next = sandbox[headerIdx + 1];
    expect(next?.ownerFlagId).toBe('exec-sandbox');
    expect(next?.setting.key.startsWith('sandbox.')).toBe(true);
  });

  test('enablement keys never appear as plain rows in their home category', () => {
    const groups = buildSettingGroups(cm, ffm);
    for (const [category, entries] of groups) {
      if (category === 'network') continue; // combined cross-list view keeps plain copies
      for (const entry of entries) {
        if (entry.flag) continue;
        expect(ENABLEMENT_KEYS.has(entry.setting.key)).toBe(false);
      }
    }
  });
});
