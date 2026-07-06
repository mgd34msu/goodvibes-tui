/**
 * settings-modal-data — pure data-assembly helpers for SettingsModal.
 *
 * All functions are stateless: they take dependencies as arguments and return
 * derived data without mutating state. The class in settings-modal.ts delegates
 * to these during open() and tab-switch operations.
 */

import { CONFIG_SCHEMA, type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import { getResolvedSettingLookup } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { buildSubscriptionEntries } from './settings-modal-subscriptions.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import { CODE_INDEX_ENABLED_CONFIG_KEY } from '../runtime/code-index-services.ts';
import { BUDGET_ALERT_USD_CONFIG_KEY, BUDGET_ALERT_USD_DEFAULT, readBudgetAlertUsd } from '../export/cost-utils.ts';
import {
  THEME_MODE_CONFIG_KEY,
  THEME_MODE_VALUES,
  THEME_MODE_DEFAULT,
  THEME_MODE_DESCRIPTION,
  coerceThemeModeSetting,
} from '../renderer/theme-mode-config.ts';
import {
  SETTINGS_CATEGORIES,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SubscriptionEntry,
} from './settings-modal-types.ts';

// ---------------------------------------------------------------------------
// deepEqual — structural equality for isDefault comparisons
// ---------------------------------------------------------------------------

/**
 * Structural equality check for setting default comparisons.
 * Handles scalars, arrays, and plain objects. Does NOT support
 * circular references or non-plain prototypes — config defaults
 * are always JSON-safe primitives, arrays, or plain objects.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// buildSettingGroups — loads CONFIG_SCHEMA into per-category SettingEntry maps
// ---------------------------------------------------------------------------

export function buildSettingGroups(
  configManager: ConfigManager,
): Map<SettingsCategory, SettingEntry[]> {
  const groups = new Map<SettingsCategory, SettingEntry[]>();
  for (const cat of SETTINGS_CATEGORIES) {
    if (cat === 'flags') continue;
    groups.set(cat, []);
  }

  for (const setting of CONFIG_SCHEMA) {
    const rawCat = setting.key.split('.')[0] as string;
    const cat = rawCat as SettingsCategory;
    const currentValue = configManager.get(setting.key as ConfigKey);
    const resolved = getResolvedSettingLookup(configManager, setting.key as ConfigKey)?.entry;
    const entry: SettingEntry = {
      setting,
      currentValue,
      isDefault: deepEqual(currentValue, setting.default),
      effectiveSource: resolved?.effectiveSource,
      locked: resolved?.locked,
      conflict: resolved?.conflict,
      sourceLabel: resolved?.sourceLabel,
      lockReason: resolved?.lockReason,
    };
    if (groups.has(cat)) groups.get(cat)!.push(entry);
    if ((rawCat === 'controlPlane' || rawCat === 'httpListener' || rawCat === 'web') && groups.has('network')) {
      groups.get('network')!.push(entry);
    }
  }

  // DEBT-2: inject the synthetic display.themeMode enum (auto|dark|light). TUI-local
  // key stored under the existing `display` section (see theme-mode-config.ts for why
  // not `appearance`), same rationale as the other synthetic settings below.
  const displayEntries = groups.get('display');
  if (displayEntries && !displayEntries.some((e) => e.setting.key === (THEME_MODE_CONFIG_KEY as ConfigKey))) {
    displayEntries.push(buildThemeModeSyntheticEntry(configManager));
  }

  const uiEntries = groups.get('ui');
  if (uiEntries) {
    const uiPriority: Record<string, number> = {
      'ui.systemMessages': 0,
      'ui.operationalMessages': 1,
      'ui.wrfcMessages': 2,
      'ui.voiceEnabled': 3,
    };
    uiEntries.sort((a, b) => (uiPriority[a.setting.key] ?? 99) - (uiPriority[b.setting.key] ?? 99));
  }

  // Cross-list ui.voiceEnabled into the 'tts' category so that /config tts
  // shows the always-speak toggle alongside the other TTS settings.
  const ttsEntries = groups.get('tts');
  if (ttsEntries && uiEntries) {
    const voiceEnabledEntry = uiEntries.find((e) => e.setting.key === 'ui.voiceEnabled');
    if (voiceEnabledEntry && !ttsEntries.some((e) => e.setting.key === 'ui.voiceEnabled')) {
      ttsEntries.unshift(voiceEnabledEntry);
    }
  }

  // Inject the synthetic tts.speed entry into the tts category.
  // tts.speed is not yet a ConfigKey in the SDK schema (pending SDK addition).
  // The entry is surfaced here with an honest description caveat so users can
  // see and understand the setting before the SDK schema catches up.
  if (ttsEntries && !ttsEntries.some((e) => e.setting.key === ('tts.speed' as ConfigKey))) {
    ttsEntries.push(buildTtsSpeedSyntheticEntry(configManager));
  }

  // Inject the synthetic behavior.notifyAfterSeconds entry into the behavior
  // category. This key is TUI-local (not in the SDK ConfigKey union) and
  // controls the long-task push notification threshold.
  const behaviorEntries = groups.get('behavior');
  if (behaviorEntries && !behaviorEntries.some((e) => e.setting.key === ('behavior.notifyAfterSeconds' as ConfigKey))) {
    behaviorEntries.push(buildNotifyAfterSecondsSyntheticEntry(configManager));
  }

  // Inject the synthetic behavior.budgetAlertUsd entry into the behavior
  // category. This key is TUI-local (not in the SDK ConfigKey union), which
  // previously left it with no schema-driven inspection surface at all: it
  // never appeared in /config, and /settings-sync show rejects any key not
  // in CONFIG_KEYS. The Cost panel's 'b' key and /cost budget <usd> remain
  // the primary way to change it; this entry makes the current effective
  // value (and whether it's still the "no budget configured" default)
  // visible from /config behavior too, same rationale as notifyAfterSeconds.
  if (behaviorEntries && !behaviorEntries.some((e) => e.setting.key === (BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey))) {
    behaviorEntries.push(buildBudgetAlertUsdSyntheticEntry(configManager));
  }

  // Inject the W2.3 alert-class toggles + master focus gate. TUI-local
  // synthetic settings, same rationale as notifyAfterSeconds above.
  if (behaviorEntries) {
    for (const entry of buildNotifyAlertSyntheticEntries(configManager)) {
      if (!behaviorEntries.some((e) => e.setting.key === entry.setting.key)) {
        behaviorEntries.push(entry);
      }
    }
  }

  // Inject the storage.codeIndexEnabled toggle into the
  // storage category. TUI-local synthetic setting (not in the SDK ConfigKey
  // union — see code-index-services.ts), same rationale as
  // notifyAfterSeconds above: opt-in, default off, states its own bounds.
  const storageEntries = groups.get('storage');
  if (storageEntries && !storageEntries.some((e) => e.setting.key === (CODE_INDEX_ENABLED_CONFIG_KEY as ConfigKey))) {
    storageEntries.push(buildCodeIndexEnabledSyntheticEntry(configManager));
  }

  return groups;
}

// ---------------------------------------------------------------------------
// TTS_SPEED_DEFAULT — the pending-SDK default for tts.speed
// ---------------------------------------------------------------------------

/**
 * Pending default for tts.speed. Matches the value the SDK will use once
 * the schema field is added: 1 (normal speed, provider default).
 * Used for the synthetic settings-modal entry and isDefault comparisons.
 */
export const TTS_SPEED_DEFAULT = 1;

/**
 * The synthetic ConfigSetting descriptor for tts.speed.
 * `tts.speed` is not yet a ConfigKey in the SDK schema. This descriptor is
 * TUI-local and is injected into the tts settings group so users can see
 * and interact with the setting before the SDK schema catches up.
 *
 * The key is cast to ConfigKey because ConfigSetting requires it and the SDK
 * will add this key in a future release. The cast is safe: configManager.get
 * returns undefined for unknown keys rather than throwing.
 */
export const TTS_SPEED_SYNTHETIC_SETTING: ConfigSetting = {
  key: 'tts.speed' as ConfigKey,
  type: 'number',
  default: TTS_SPEED_DEFAULT,
  description: 'Playback speed multiplier passed to the TTS provider (1.0 = normal). Takes effect immediately via the TUI bridge; SDK schema registration is pending (native typing only).',
};

/**
 * Build the synthetic SettingEntry for tts.speed.
 *
 * Reads the raw value from configManager using a cast key (tts.speed is not
 * yet a valid ConfigKey). If the value is absent or not a positive finite
 * number, falls back to TTS_SPEED_DEFAULT and marks isDefault true.
 */
export function buildTtsSpeedSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const raw = configManager.get('tts.speed' as ConfigKey);
  const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  const currentValue: number = isFinite(parsed) && parsed > 0 ? parsed : TTS_SPEED_DEFAULT;
  return {
    setting: TTS_SPEED_SYNTHETIC_SETTING,
    currentValue,
    isDefault: deepEqual(currentValue, TTS_SPEED_DEFAULT),
  };
}

// ---------------------------------------------------------------------------
// display.themeMode synthetic setting (DEBT-2 light theme)
// ---------------------------------------------------------------------------

/**
 * The synthetic ConfigSetting descriptor for display.themeMode. TUI-local (not
 * in the SDK ConfigKey union); the key is cast to ConfigKey as the other
 * synthetic settings do. Stored under the existing `display` section so
 * ConfigManager.setDynamic/get round-trip it with no SDK change.
 */
export const THEME_MODE_SYNTHETIC_SETTING: ConfigSetting = {
  key: THEME_MODE_CONFIG_KEY as ConfigKey,
  type: 'enum',
  default: THEME_MODE_DEFAULT,
  enumValues: [...THEME_MODE_VALUES],
  description: THEME_MODE_DESCRIPTION,
};

/** Build the synthetic SettingEntry for display.themeMode. */
export function buildThemeModeSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const currentValue = coerceThemeModeSetting(configManager.get(THEME_MODE_CONFIG_KEY as ConfigKey));
  return {
    setting: THEME_MODE_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue === THEME_MODE_DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// behavior.notifyAfterSeconds synthetic setting
// ---------------------------------------------------------------------------

/** Default threshold in seconds for the synthetic notifyAfterSeconds setting. */
export const NOTIFY_AFTER_SECONDS_DEFAULT_SETTING = 60;

/**
 * The synthetic ConfigSetting descriptor for behavior.notifyAfterSeconds.
 *
 * This key is TUI-local and is not yet in the SDK ConfigKey union. The
 * descriptor is injected into the behavior settings group so users can
 * configure the long-task push notification threshold from /config behavior.
 *
 * 0 = off (no notifications). Any positive integer = threshold in seconds.
 * Default 60s matches the default in long-task-notifier.ts.
 *
 * The key is cast to ConfigKey because ConfigSetting requires it. The cast
 * is safe: configManager.get returns undefined for unknown keys rather than
 * throwing.
 */
export const NOTIFY_AFTER_SECONDS_SYNTHETIC_SETTING: ConfigSetting = {
  key: 'behavior.notifyAfterSeconds' as ConfigKey,
  type: 'number',
  default: NOTIFY_AFTER_SECONDS_DEFAULT_SETTING,
  description: 'Seconds a turn must run before a push notification fires (0 = off). Delivers to desktop (notify-send/osascript) and configured ntfy/webhook URLs.',
};

/**
 * Build the synthetic SettingEntry for behavior.notifyAfterSeconds.
 *
 * Reads the raw value from configManager using a cast key. Falls back to
 * NOTIFY_AFTER_SECONDS_DEFAULT_SETTING when absent or invalid.
 */
export function buildNotifyAfterSecondsSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const raw = configManager.get('behavior.notifyAfterSeconds' as ConfigKey);
  const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  const currentValue: number = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : NOTIFY_AFTER_SECONDS_DEFAULT_SETTING;
  return {
    setting: NOTIFY_AFTER_SECONDS_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue === NOTIFY_AFTER_SECONDS_DEFAULT_SETTING,
  };
}

// ---------------------------------------------------------------------------
// behavior.budgetAlertUsd synthetic setting
// ---------------------------------------------------------------------------

/**
 * The synthetic ConfigSetting descriptor for behavior.budgetAlertUsd.
 *
 * This key is TUI-local and is not yet in the SDK ConfigKey union — it never
 * appeared in CONFIG_SCHEMA, so it was invisible to every schema-driven
 * inspection surface (/config, /settings-sync show <key>) even though the
 * value round-trips correctly through configManager.get/set. The descriptor
 * is injected into the behavior settings group so /config behavior shows the
 * real current threshold, not just the behavior.notifyOnBudgetBreach gate.
 *
 * 0 = no budget configured (disabled). Any positive number = the USD
 * threshold. Default matches BUDGET_ALERT_USD_DEFAULT in cost-utils.ts, the
 * single source of truth CostTrackerPanel and budget-breach-notifier.ts share.
 */
export const BUDGET_ALERT_USD_SYNTHETIC_SETTING: ConfigSetting = {
  key: BUDGET_ALERT_USD_CONFIG_KEY as ConfigKey,
  type: 'number',
  default: BUDGET_ALERT_USD_DEFAULT,
  description: 'Session cost-budget alert threshold in USD (0 = no budget configured). Set via the Cost panel\'s "b" key or /cost budget <usd>; this entry only displays the current effective value.',
};

/**
 * Build the synthetic SettingEntry for behavior.budgetAlertUsd.
 *
 * Delegates parsing/fallback to readBudgetAlertUsd (cost-utils.ts) so this
 * display entry can never disagree with what CostTrackerPanel and the
 * background budget-breach notifier actually read.
 */
export function buildBudgetAlertUsdSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const currentValue = readBudgetAlertUsd((key) => configManager.get(key as ConfigKey));
  return {
    setting: BUDGET_ALERT_USD_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue === BUDGET_ALERT_USD_DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// W2.3 alert-class synthetic settings — behavior.notifyOn* + notifyOnlyWhenUnfocused
// ---------------------------------------------------------------------------

/**
 * The five W2.3 alert-gating booleans, all TUI-local (not yet in the SDK
 * ConfigKey union), all defaulting to on. Read/written generically by
 * core/alert-gating.ts (readBooleanConfig) and the per-alert-class modules
 * (budget-breach-notifier.ts, approval-alert.ts, turn-event-wiring.ts,
 * long-task-notifier.ts) — this is only the settings-modal-visible surface.
 */
const NOTIFY_ALERT_SYNTHETIC_SETTINGS: ReadonlyArray<{ readonly key: string; readonly description: string }> = [
  {
    key: 'behavior.notifyOnBudgetBreach',
    description: 'Alert when session cost crosses the configured budget (set via the Cost panel\'s "b" key).',
  },
  {
    key: 'behavior.notifyOnAgentFailure',
    description: 'Alert when a delegated or background agent fails.',
  },
  {
    key: 'behavior.notifyOnChainFailure',
    description: 'Alert when a WRFC review chain fails.',
  },
  {
    key: 'behavior.notifyOnApprovalPending',
    description: 'Alert when a tool call is waiting on your approval.',
  },
  {
    key: 'behavior.notifyOnlyWhenUnfocused',
    description: 'Master gate for the four alerts above: fire only when the terminal window is unfocused, or when focus state was never observed (terminal does not report focus). Turn off to always fire regardless of focus.',
  },
];

function buildBooleanSyntheticEntry(
  configManager: Pick<ConfigManager, 'get'>,
  key: string,
  description: string,
  defaultValue: boolean,
): SettingEntry {
  const raw = configManager.get(key as ConfigKey);
  const currentValue = typeof raw === 'boolean' ? raw : defaultValue;
  return {
    setting: { key: key as ConfigKey, type: 'boolean', default: defaultValue, description },
    currentValue,
    isDefault: currentValue === defaultValue,
  };
}

/** Build the five synthetic SettingEntry rows for the behavior category. */
export function buildNotifyAlertSyntheticEntries(configManager: Pick<ConfigManager, 'get'>): SettingEntry[] {
  return NOTIFY_ALERT_SYNTHETIC_SETTINGS.map((spec) => buildBooleanSyntheticEntry(configManager, spec.key, spec.description, true));
}

// ---------------------------------------------------------------------------
// storage.codeIndexEnabled synthetic setting
// ---------------------------------------------------------------------------

/**
 * The repo source-tree code index's auto-build-on-startup toggle
 * (code-index-services.ts). TUI-local, default OFF: /codebase build is the
 * explicit trigger unless a user opts in here. Honest bounds stated inline
 * so enabling this isn't a surprise — see code-index-services.ts's
 * CODE_INDEX_MAX_FILES/CODE_INDEX_MAX_FILE_BYTES for the numbers this
 * description would otherwise duplicate as magic numbers.
 */
export function buildCodeIndexEnabledSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  return buildBooleanSyntheticEntry(
    configManager,
    CODE_INDEX_ENABLED_CONFIG_KEY,
    'Auto-build the repo source-tree code index on startup (bounded file/size scan; see /codebase status for bounds). Off by default — /codebase build indexes on demand.',
    false,
  );
}

// ---------------------------------------------------------------------------
// buildFlagEntries — snapshot of current feature flag states
// ---------------------------------------------------------------------------

export function buildFlagEntries(featureFlagManager: FeatureFlagManager | null): FlagEntry[] {
  if (!featureFlagManager) return [];
  return Array.from(featureFlagManager.getAll().values()).map(({ flag, state }) => ({
    flag,
    state,
  }));
}

// ---------------------------------------------------------------------------
// buildMcpEntries — snapshot of current MCP server security entries
// ---------------------------------------------------------------------------

export function buildMcpEntries(mcpRegistry: McpRegistry | null): McpEntry[] {
  if (!mcpRegistry) return [];
  return mcpRegistry.listServerSecurity().map((entry) => ({
    name: entry.name,
    connected: entry.connected,
    role: entry.role,
    trustMode: entry.trustMode,
    allowedPaths: [...entry.allowedPaths],
    allowedHosts: [...entry.allowedHosts],
  }));
}

// ---------------------------------------------------------------------------
// buildSubscriptionEntries — re-export for use by SettingsModal
// ---------------------------------------------------------------------------

export { buildSubscriptionEntries };

// ---------------------------------------------------------------------------
// buildNetworkFilteredItems — applies host-mode visibility rules for 'network' tab
// ---------------------------------------------------------------------------

export function buildNetworkFilteredItems(
  items: SettingEntry[],
  configManager: ConfigManager | null,
): SettingEntry[] {
  return items.filter(entry => {
    if (entry.setting.key === 'controlPlane.host') {
      return configManager?.get('controlPlane.hostMode') === 'custom';
    }
    if (entry.setting.key === 'httpListener.host') {
      return configManager?.get('httpListener.hostMode') === 'custom';
    }
    if (entry.setting.key === 'web.host') {
      return configManager?.get('web.hostMode') === 'custom';
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// refreshEntryValues — re-reads currentValue/isDefault for all loaded entries
// ---------------------------------------------------------------------------

/**
 * Normalize a raw config value for the tts.speed synthetic entry.
 * Returns the raw value if it is a positive finite number, otherwise falls
 * back to TTS_SPEED_DEFAULT. Mirrors the logic in buildTtsSpeedSyntheticEntry.
 */
function normalizeTtsSpeedValue(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return isFinite(parsed) && parsed > 0 ? parsed : TTS_SPEED_DEFAULT;
}

export function refreshEntryValues(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: ConfigManager,
): void {
  for (const entries of groups.values()) {
    for (const entry of entries) {
      const raw = configManager.get(entry.setting.key as ConfigKey);
      // Synthetic entries (e.g. tts.speed) that have no SDK schema key return
      // undefined from configManager. Normalize using the same logic used at
      // construction time so isDefault stays accurate.
      if (entry.setting.key === ('tts.speed' as ConfigKey)) {
        entry.currentValue = normalizeTtsSpeedValue(raw);
      } else if (entry.setting.key === (THEME_MODE_CONFIG_KEY as ConfigKey)) {
        entry.currentValue = coerceThemeModeSetting(raw);
      } else {
        entry.currentValue = raw;
      }
      entry.isDefault = deepEqual(entry.currentValue, entry.setting.default);
    }
  }
}

// ---------------------------------------------------------------------------
// updateEntryForKey — updates a single setting entry after a value change
// ---------------------------------------------------------------------------

export function updateEntryForKey(
  groups: Map<SettingsCategory, SettingEntry[]>,
  key: ConfigKey,
  configManager: ConfigManager,
): void {
  for (const entries of groups.values()) {
    const entry = entries.find((candidate) => candidate.setting.key === key);
    if (entry) {
      const raw = configManager.get(key);
      // Synthetic entries: normalize using the same fallback logic as construction.
      entry.currentValue = key === ('tts.speed' as ConfigKey)
        ? normalizeTtsSpeedValue(raw)
        : key === (THEME_MODE_CONFIG_KEY as ConfigKey)
          ? coerceThemeModeSetting(raw)
          : raw;
      entry.isDefault = deepEqual(entry.currentValue, entry.setting.default);
    }
  }
}

// ---------------------------------------------------------------------------
// fuzzyScoreSettingEntry — score an entry against a query for ranked search
// ---------------------------------------------------------------------------

/**
 * Score a single SettingEntry against a search query.
 *
 * Score tiers (higher = better match):
 *   - 3000–3999: exact key substring match (3000 + position bonus 0–999)
 *   - 2000–2999: exact label substring match (2000 + position bonus 0–999)
 *   - 1000–1999: exact description substring match (1000 + position bonus 0–999)
 *   - 1–99:      subsequence match across key+label+description
 *
 * Returns null when the query does not match at all.
 *
 * @param query - The search string (already lowercased).
 * @param entry - The setting entry to test.
 * @param getLabel - Pure function mapping an entry to its display label.
 */
export function fuzzyScoreSettingEntry(
  query: string,
  entry: SettingEntry,
  getLabel: (e: SettingEntry) => string,
): number | null {
  if (query.length === 0) return 0;
  const lq = query.toLowerCase();
  const key = entry.setting.key.toLowerCase();
  const label = getLabel(entry).toLowerCase();
  const description = (entry.setting.description ?? '').toLowerCase();

  // Tier 1: key substring — base 3000, position bonus up to 999
  // A key match at position 0 scores 3999; at position 999 scores 3000.
  const keyIdx = key.indexOf(lq);
  if (keyIdx !== -1) return 3000 + Math.max(0, 999 - keyIdx);

  // Tier 2: label substring — base 2000, position bonus up to 999
  const labelIdx = label.indexOf(lq);
  if (labelIdx !== -1) return 2000 + Math.max(0, 999 - labelIdx);

  // Tier 3: description substring — base 1000, position bonus up to 999
  const descIdx = description.indexOf(lq);
  if (descIdx !== -1) return 1000 + Math.max(0, 999 - descIdx);

  // Tier 4: subsequence across concatenated key + label + description — 1..99
  const haystack = `${key} ${label} ${description}`;
  let qi = 0;
  let score = 0;
  for (let ci = 0; ci < haystack.length && qi < lq.length; ci++) {
    if (haystack[ci] === lq[qi]) {
      qi++;
      score++;
    }
  }
  if (qi === lq.length) return Math.min(99, score);
  return null;
}

/**
 * Search all setting entries across all groups, returning results ranked by
 * relevance score (highest first). Excludes the flags, mcp, and subscriptions
 * special categories (which have their own entry types).
 *
 * @param query - User input string. Empty string returns []. 
 * @param groups - The settings group map from buildSettingGroups.
 * @param getLabel - Pure function mapping an entry to its display label.
 */
export function searchSettingEntries(
  query: string,
  groups: Map<SettingsCategory, SettingEntry[]>,
  getLabel: (e: SettingEntry) => string,
): SettingEntry[] {
  if (query.trim().length === 0) return [];
  const lq = query.trim().toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ entry: SettingEntry; score: number }> = [];
  for (const entries of groups.values()) {
    for (const entry of entries) {
      // Deduplicate: network tab cross-lists keys already in controlPlane/httpListener/web
      if (seen.has(entry.setting.key)) continue;
      seen.add(entry.setting.key);
      const score = fuzzyScoreSettingEntry(lq, entry, getLabel);
      if (score !== null) scored.push({ entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(r => r.entry);
}

// ---------------------------------------------------------------------------
// Re-export SubscriptionEntry for convenience
// ---------------------------------------------------------------------------

export type { SubscriptionEntry } from './settings-modal-types.ts';
export type { SubscriptionManager };
export type { ServiceInspectionQuery };
