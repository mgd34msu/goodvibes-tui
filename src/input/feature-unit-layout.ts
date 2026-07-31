/**
 * feature-unit-layout — every platform capability renders as a feature UNIT in
 * its settings DOMAIN: the feature's real enablement row (its domain settings
 * key, with the feature's name and full description attached) immediately
 * followed by the settings keys that tune it.
 *
 * Grouping metadata is sourced entirely from the SDK's FEATURE_SETTINGS
 * surface (the single source of truth, completeness test-guarded SDK-side):
 * `domain` is the top-level settings namespace the feature lives in, the
 * enablement binding carries the real option shape (boolean switch, enum mode
 * choices, or a constant capability), and `settings` lists every key that
 * configures the feature.
 *
 * A feature-unit header is the REAL config row for the feature's enablement
 * key — boolean headers toggle, enum headers cycle their mode choices through
 * the ordinary settings interactions. Two features can share one enablement
 * key (e.g. behavior.compactionStrategy drives both compaction features);
 * each still gets its own header row so every capability keeps its own name,
 * description, and state, all reading the same underlying key.
 */

import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import type { FeatureSetting } from '@pellux/goodvibes-sdk/platform/runtime/state';
import type { ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import { getConfigSchemaSetting } from '@pellux/goodvibes-terminal-shell';
import type { FlagEntry, SettingEntry, SettingsCategory } from './settings-modal-types.ts';

/** Every enablement key — these rows render as feature headers, never as plain sub-rows. */
const ENABLEMENT_KEYS: ReadonlySet<string> = new Set(
  FEATURE_SETTINGS.map((feature) => feature.enablement.key),
);

/**
 * Host category for a feature unit: its settings domain (the top-level
 * namespace of its enablement key), which is always a real settings category.
 */
export function getFeatureUnitHostCategory(featureId: string): SettingsCategory | null {
  const feature = FEATURE_SETTINGS.find((candidate) => candidate.id === featureId);
  return feature ? (feature.domain as SettingsCategory) : null;
}

/**
 * Map every non-enablement settings key claimed by any feature to the feature
 * that OWNS it — the first feature (in FEATURE_SETTINGS declaration order)
 * whose settings list contains it. A key claimed by two features is listed
 * once, under its owner, so no settings key double-lists across feature units.
 */
export function buildConfigKeyOwnership(): Map<string, string> {
  const owner = new Map<string, string>();
  for (const feature of FEATURE_SETTINGS) {
    for (const key of feature.settings) {
      if (ENABLEMENT_KEYS.has(key)) continue;
      if (!owner.has(key)) owner.set(key, feature.id);
    }
  }
  return owner;
}

/**
 * Build a feature unit's header row: the REAL config row for the feature's
 * enablement key (so booleans toggle and enums cycle their mode choices
 * through the ordinary settings paths), cloned with the feature attached.
 * When the category has no row for the key (it should always have one — every
 * binding key is CONFIG_SCHEMA-registered), the schema descriptor is used
 * directly so the header still renders honestly.
 */
export function buildFeatureHeaderEntry(entry: FlagEntry, base: SettingEntry | null): SettingEntry {
  const feature = entry.feature;
  const setting: ConfigSetting = base?.setting
    ?? getConfigSchemaSetting(feature.enablement.key)
    ?? {
      key: feature.enablement.key,
      type: 'boolean',
      default: feature.defaultEnabled,
      description: feature.description,
    };
  return {
    ...(base ?? {}),
    setting,
    currentValue: base ? base.currentValue : setting.default,
    isDefault: base ? base.isDefault : true,
    flag: entry,
  };
}

/** Shallow-clone a config SettingEntry so a host-category copy can carry ownerFlagId without mutating a cross-listed original (e.g. the network combined view shares controlPlane/web entry objects). */
function cloneOwnedEntry(entry: SettingEntry, ownerFlagId: string): SettingEntry {
  return { ...entry, ownerFlagId };
}

/**
 * Rewrite `groups` in place so each settings domain leads with its feature
 * units (feature header + its owned settings sub-rows, in FEATURE_SETTINGS
 * declaration order), followed by the category's remaining un-owned rows.
 * The plain rows for enablement keys are consumed into the headers; cross
 * listed copies in the combined network view keep their plain form.
 *
 * No-op when there are no feature entries (the featureless test path),
 * leaving the plain namespace-bucketed layout intact.
 */
export function applyFeatureUnitLayout(
  groups: Map<SettingsCategory, SettingEntry[]>,
  flagEntries: readonly FlagEntry[],
): void {
  if (flagEntries.length === 0) return;
  const owner = buildConfigKeyOwnership();
  const entryById = new Map<string, FlagEntry>(flagEntries.map((entry) => [entry.feature.id, entry]));

  // Group the features this runtime actually registered by their domain,
  // preserving FEATURE_SETTINGS declaration order within each category.
  const featuresByCategory = new Map<SettingsCategory, FeatureSetting[]>();
  for (const feature of FEATURE_SETTINGS) {
    if (!entryById.has(feature.id)) continue; // not registered in this runtime
    const category = feature.domain as SettingsCategory;
    if (!featuresByCategory.has(category)) featuresByCategory.set(category, []);
    featuresByCategory.get(category)!.push(feature);
  }

  for (const [category, features] of featuresByCategory) {
    const existing = groups.get(category) ?? [];
    const rowByKey = new Map<string, SettingEntry>();
    for (const entry of existing) {
      if (!rowByKey.has(entry.setting.key)) rowByKey.set(entry.setting.key, entry);
    }

    // Split existing config rows: enablement rows are consumed into headers,
    // rows owned by a feature hosted here become indented sub-rows, and the
    // rest stay as orphan rows after the feature units.
    const hostedEnablementKeys = new Set(features.map((feature) => feature.enablement.key));
    const ownedByFeature = new Map<string, SettingEntry[]>();
    const orphans: SettingEntry[] = [];
    for (const entry of existing) {
      const key = entry.setting.key;
      if (hostedEnablementKeys.has(key)) continue; // consumed into header(s)
      const ownerId = owner.get(key);
      if (ownerId !== undefined && entryById.has(ownerId)) {
        if (!ownedByFeature.has(ownerId)) ownedByFeature.set(ownerId, []);
        ownedByFeature.get(ownerId)!.push(cloneOwnedEntry(entry, ownerId));
      } else {
        orphans.push(entry);
      }
    }

    const rebuilt: SettingEntry[] = [];
    for (const feature of features) {
      const base = rowByKey.get(feature.enablement.key) ?? null;
      rebuilt.push(buildFeatureHeaderEntry(entryById.get(feature.id)!, base));
      for (const sub of ownedByFeature.get(feature.id) ?? []) rebuilt.push(sub);
    }
    rebuilt.push(...orphans);
    groups.set(category, rebuilt);
  }
}
