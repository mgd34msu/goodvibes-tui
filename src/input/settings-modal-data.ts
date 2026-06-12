/**
 * settings-modal-data — pure data-assembly helpers for SettingsModal.
 *
 * All functions are stateless: they take dependencies as arguments and return
 * derived data without mutating state. The class in settings-modal.ts delegates
 * to these during open() and tab-switch operations.
 */

import { CONFIG_SCHEMA, type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { getResolvedSettingLookup } from '@/runtime/index.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { buildSubscriptionEntries } from './settings-modal-subscriptions.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
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

  return groups;
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

export function refreshEntryValues(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: ConfigManager,
): void {
  for (const entries of groups.values()) {
    for (const entry of entries) {
      entry.currentValue = configManager.get(entry.setting.key as ConfigKey);
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
      entry.currentValue = configManager.get(key);
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
