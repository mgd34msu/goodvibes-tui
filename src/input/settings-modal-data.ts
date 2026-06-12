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
      isDefault: currentValue === setting.default,
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
      entry.isDefault = entry.currentValue === entry.setting.default;
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
      entry.isDefault = entry.currentValue === entry.setting.default;
    }
  }
}

// ---------------------------------------------------------------------------
// Re-export SubscriptionEntry for convenience
// ---------------------------------------------------------------------------

export type { SubscriptionEntry } from './settings-modal-types.ts';
export type { SubscriptionManager };
export type { ServiceInspectionQuery };
