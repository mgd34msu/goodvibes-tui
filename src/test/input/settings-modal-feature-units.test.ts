/**
 * Feature-unit presentation in the settings modal.
 *
 * Every feature flag renders as ONE unit — its toggle header plus the config
 * keys that tune it — hosted in a topical category, sourced from the SDK's
 * FEATURE_FLAG_CONFIG map. This locks:
 *   - every flag is reachable in the settings structure (cross-surface item 5);
 *   - a flag's config keys sit under its header, not double-listed as orphans;
 *   - no-config flags land in the Advanced Features bucket as bare toggles;
 *   - toggling a header routes through the feature-flag manager (config effect).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_FLAGS, FEATURE_FLAG_CONFIG } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { buildSettingGroups } from '../../input/settings-modal-data.ts';
import { getFeatureUnitHostCategory, ADVANCED_FEATURES_CATEGORY } from '../../input/feature-unit-layout.ts';
import type { SettingEntry, SettingsCategory } from '../../input/settings-modal-types.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-feature-units-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('settings modal — feature units', () => {
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
        if (entry.flag) headers.set(entry.flag.flag.id, { category, entry });
      }
    }
    return headers;
  }

  test('every feature flag is reachable as a unit header in the settings structure', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);
    for (const flag of FEATURE_FLAGS) {
      expect(headers.has(flag.id)).toBe(true);
    }
    // Exactly one header per flag — no flag appears twice.
    let headerCount = 0;
    for (const entries of groups.values()) headerCount += entries.filter((e) => e.flag).length;
    expect(headerCount).toBe(FEATURE_FLAGS.length);
  });

  test('each flag unit is hosted in the category its config namespace maps to', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);
    for (const flag of FEATURE_FLAGS) {
      const placed = headers.get(flag.id)!;
      expect(placed.category).toBe(getFeatureUnitHostCategory(flag.id));
    }
  });

  test("a flag's config keys sit under its header and are not double-listed as orphan rows", () => {
    const groups = buildSettingGroups(cm, ffm);
    // Build the set of keys owned by SOME flag.
    const ownedKeys = new Set<string>();
    for (const assoc of Object.values(FEATURE_FLAG_CONFIG)) for (const k of assoc.configKeys) ownedKeys.add(k);

    // Within each key's HOME (namespace) category, an owned key appears exactly
    // once, as a sub-option under its unit — never as an un-owned orphan row. The
    // 'network' category is a deliberate combined cross-list view of
    // controlPlane/httpListener/web keys (a focused network-config tab that
    // predates feature units); it is not any key's home category, so it is
    // excluded from the double-listing rule.
    const seen = new Map<string, number>();
    for (const [category, entries] of groups) {
      if (category === 'network') continue;
      for (const entry of entries) {
        if (entry.flag) continue; // header row, not a config key
        if (!ownedKeys.has(entry.setting.key)) continue;
        // An owned config key row MUST be marked as owned (a sub-option).
        expect(entry.ownerFlagId).toBeDefined();
        seen.set(entry.setting.key, (seen.get(entry.setting.key) ?? 0) + 1);
      }
    }
    for (const key of ownedKeys) {
      // Present exactly once (some owned keys are shared by two flags but listed
      // under a single owner, so at most once; every owned key that exists in the
      // schema is listed once).
      expect(seen.get(key) ?? 0).toBeLessThanOrEqual(1);
    }

    // Spot-check a representative unit: exec-sandbox owns sandbox.enabled et al.,
    // and they render directly after the exec-sandbox header in the sandbox category.
    const sandbox = groups.get('sandbox') ?? [];
    const headerIdx = sandbox.findIndex((e) => e.flag?.flag.id === 'exec-sandbox');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const next = sandbox[headerIdx + 1];
    expect(next?.ownerFlagId).toBe('exec-sandbox');
    expect(next?.setting.key.startsWith('sandbox.')).toBe(true);
  });

  test('no-config flags land in the Advanced Features bucket as bare toggles', () => {
    const groups = buildSettingGroups(cm, ffm);
    const advanced = groups.get(ADVANCED_FEATURES_CATEGORY) ?? [];
    // Every entry in Advanced Features is a flag header (no orphan config rows).
    for (const entry of advanced) expect(entry.flag).toBeDefined();
    // The no-config flags are exactly the ones with empty FEATURE_FLAG_CONFIG.
    const advancedIds = new Set(advanced.map((e) => e.flag!.flag.id));
    for (const flag of FEATURE_FLAGS) {
      const assoc = FEATURE_FLAG_CONFIG[flag.id];
      const hasConfig = (assoc?.configKeys.length ?? 0) > 0;
      expect(advancedIds.has(flag.id)).toBe(!hasConfig);
    }
  });

  test('a flag header carries its live state and default marker, not a raw boolean key', () => {
    const groups = buildSettingGroups(cm, ffm);
    const headers = collectHeaders(groups);
    // control-plane-gateway defaults ON; with no override it is enabled + at default.
    const cpg = headers.get('control-plane-gateway')!.entry;
    expect(cpg.setting.key).toBe('featureFlags.control-plane-gateway');
    expect(cpg.setting.type).toBe('boolean');
    expect(cpg.flag!.state).toBe('enabled');
    expect(cpg.currentValue).toBe(true);
    expect(cpg.isDefault).toBe(true);

    // fetch-sanitization defaults OFF.
    const fetch = headers.get('fetch-sanitization')!.entry;
    expect(fetch.flag!.state).toBe('disabled');
    expect(fetch.currentValue).toBe(false);
    expect(fetch.isDefault).toBe(true);
  });
});
