/**
 * feature-unit-layout — turns the flat "44 flags in one bucket + their config
 * keys scattered across namespace categories" layout into feature UNITS: each
 * feature flag renders as a toggle header immediately followed by the config
 * keys that tune it, hosted in the topical category its config lives under
 * (sandbox with Runtime & Data, surfaces with Surfaces & Cloud, and so on).
 *
 * Grouping metadata is sourced entirely from the SDK's FEATURE_FLAG_CONFIG map
 * (the single source of truth, completeness test-guarded SDK-side) so the three
 * surfaces that present features — the settings modal, the onboarding wizard,
 * and /flags — agree on which config keys belong to which flag.
 *
 * A flag whose FEATURE_FLAG_CONFIG entry has no config keys is hosted in the
 * Advanced Features bucket as a simple toggle (genuinely internal / startup-gated
 * plumbing flags with nothing to tune).
 */

import { FEATURE_FLAG_CONFIG, FEATURE_FLAGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import type { ConfigKey, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { FeatureFlag } from '@/runtime/index.ts';
import type { FlagEntry, SettingEntry, SettingsCategory } from './settings-modal-types.ts';

/**
 * The category that hosts flags with no tunable config keys. Repurposed from the
 * old flat "Feature Flags" tab — it now holds only the internal/plumbing flags
 * that have nothing to configure, as simple toggles.
 */
export const ADVANCED_FEATURES_CATEGORY: SettingsCategory = 'flags';

/**
 * Host category for a flag's feature unit: the single top-level namespace its
 * config keys live under (verified single-namespace SDK-side), or the Advanced
 * Features bucket when the flag has no config keys.
 */
export function getFeatureUnitHostCategory(flagId: string): SettingsCategory {
  const assoc = FEATURE_FLAG_CONFIG[flagId];
  const namespace = assoc?.configCategories[0];
  return (namespace ?? ADVANCED_FEATURES_CATEGORY) as SettingsCategory;
}

/**
 * Map every config key claimed by any flag to the flag that OWNS it — the first
 * flag (in FEATURE_FLAGS declaration order) whose FEATURE_FLAG_CONFIG entry lists
 * it. A key claimed by two flags (e.g. behavior.compactionStrategy, shared by
 * session-compaction and compaction-distiller-strategy) is listed once, under its
 * owner, so no config key double-lists across feature units.
 */
export function buildConfigKeyOwnership(): Map<string, string> {
  const owner = new Map<string, string>();
  for (const flag of FEATURE_FLAGS) {
    const assoc = FEATURE_FLAG_CONFIG[flag.id];
    if (!assoc) continue;
    for (const key of assoc.configKeys) {
      if (!owner.has(key)) owner.set(key, flag.id);
    }
  }
  return owner;
}

/**
 * Build the synthetic SettingEntry that is a feature unit's toggle header. Its
 * key is `featureFlags.<id>` (the same override path persistFlagState writes), so
 * it round-trips through the config layer; type boolean so the existing
 * activate/adjust toggle paths drive it. currentValue mirrors the live runtime
 * state; isDefault is true when the flag sits at its declared default state (so
 * the "modified" marker shows only for an actual override). The attached
 * `flag` marks the row as a feature-unit header for rendering and interaction.
 */
export function buildFlagHeaderEntry(entry: FlagEntry): SettingEntry {
  const { flag, state } = entry;
  const setting: ConfigSetting = {
    key: `featureFlags.${flag.id}` as ConfigKey,
    type: 'boolean',
    default: flag.defaultState === 'enabled',
    description: flag.description,
  };
  return {
    setting,
    currentValue: state === 'enabled',
    isDefault: state === flag.defaultState,
    flag: entry,
  };
}

/** Shallow-clone a config SettingEntry so a host-category copy can carry ownerFlagId without mutating a cross-listed original (e.g. the network combined view shares controlPlane/web entry objects). */
function cloneOwnedEntry(entry: SettingEntry, ownerFlagId: string): SettingEntry {
  return { ...entry, ownerFlagId };
}

/**
 * Rewrite `groups` in place so each host category leads with its feature units
 * (flag toggle header + its owned config sub-options, in FEATURE_FLAGS order),
 * followed by the category's remaining un-owned config rows. The Advanced
 * Features category is filled with the no-config flags as bare toggles.
 *
 * No-op when there are no flag entries (the flagless test path), leaving the
 * plain namespace-bucketed layout intact.
 */
export function applyFeatureUnitLayout(
  groups: Map<SettingsCategory, SettingEntry[]>,
  flagEntries: readonly FlagEntry[],
): void {
  if (flagEntries.length === 0) return;
  const owner = buildConfigKeyOwnership();
  const flagState = new Map<string, FlagEntry>(flagEntries.map((entry) => [entry.flag.id, entry]));

  // Group the flags this runtime actually registered by their host category,
  // preserving FEATURE_FLAGS declaration order within each category.
  const flagsByCategory = new Map<SettingsCategory, FeatureFlag[]>();
  for (const flag of FEATURE_FLAGS) {
    if (!flagState.has(flag.id)) continue; // not registered in this runtime
    const category = getFeatureUnitHostCategory(flag.id);
    if (!flagsByCategory.has(category)) flagsByCategory.set(category, []);
    flagsByCategory.get(category)!.push(flag);
  }

  for (const [category, flags] of flagsByCategory) {
    const existing = groups.get(category) ?? [];
    // Split existing config rows into those owned by a feature unit hosted here
    // and the remaining orphan rows. An owned row's owner is guaranteed to be a
    // flag hosted in THIS category (owned keys share the flag's namespace).
    const ownedByFlag = new Map<string, SettingEntry[]>();
    const orphans: SettingEntry[] = [];
    for (const entry of existing) {
      const ownerId = owner.get(entry.setting.key);
      if (ownerId !== undefined && flagState.has(ownerId)) {
        if (!ownedByFlag.has(ownerId)) ownedByFlag.set(ownerId, []);
        ownedByFlag.get(ownerId)!.push(cloneOwnedEntry(entry, ownerId));
      } else {
        orphans.push(entry);
      }
    }

    const rebuilt: SettingEntry[] = [];
    for (const flag of flags) {
      rebuilt.push(buildFlagHeaderEntry(flagState.get(flag.id)!));
      for (const sub of ownedByFlag.get(flag.id) ?? []) rebuilt.push(sub);
    }
    rebuilt.push(...orphans);
    groups.set(category, rebuilt);
  }
}
