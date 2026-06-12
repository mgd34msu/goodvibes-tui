/**
 * settings-modal-mutations — pure mutation helpers for SettingsModal.
 *
 * These functions encapsulate the side-effectful write operations:
 * applying config values, persisting feature flag state, and applying flag
 * runtime toggles. Each function takes its dependencies as explicit arguments
 * rather than accessing class-level state.
 */

import type { ConfigKey, PersistedFlagState } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FeatureFlag, FlagState } from '@/runtime/index.ts';
import type { FlagEntry, SettingEntry } from './settings-modal-types.ts';
import { deepEqual } from './settings-modal-data.ts';

// ---------------------------------------------------------------------------
// ApplyValueResult — returned by applySettingValue so the caller can react
// ---------------------------------------------------------------------------

export interface ApplyValueResult {
  /** Restart domain that was triggered, if any. */
  readonly restartDomain: 'control-plane' | 'http-listener' | 'web' | null;
  /** Message from onSettingApplied handler, if any. */
  readonly effectMessage: string | null;
  /** Whether the value actually changed (false = no-op). */
  readonly changed: boolean;
}

export type SettingAppliedCallback = (change: {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}) => { readonly message?: string } | void;

// ---------------------------------------------------------------------------
// applySettingValue
// ---------------------------------------------------------------------------

export function applySettingValue({
  key,
  value,
  configManager,
  groups,
  onSettingApplied,
  refreshGroups,
}: {
  key: ConfigKey;
  value: unknown;
  configManager: ConfigManager;
  groups: Map<string, SettingEntry[]>;
  onSettingApplied: SettingAppliedCallback | null;
  /** Called after applying the value so the caller can re-read currentValues. */
  refreshGroups: () => void;
}): ApplyValueResult {
  const previousValue = configManager.get(key);
  // REQUIRES_RESTART: SDK's ConfigSetting has no requiresRestart field yet (see
  // goodvibes-sdk HANDOFF-FROM-TUI-SESSION-20260611.md §Item 8). Until it does,
  // we detect restart-triggering keys by sub-key name heuristic below.
  const isRestartKey = ['host', 'port', 'hostMode', 'enabled'].includes(key.split('.')[1] ?? '');

  try {
    configManager.setDynamic(key, value);
  } catch (e) {
    logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
    return {
      restartDomain: null,
      effectMessage: `Save failed: ${summarizeError(e)}`,
      changed: false,
    };
  }

  // Update the entry in the groups map
  for (const entries of groups.values()) {
    const entry = entries.find((candidate) => candidate.setting.key === key);
    if (entry) {
      entry.currentValue = configManager.get(key);
      entry.isDefault = deepEqual(entry.currentValue, entry.setting.default);
    }
  }

  // Determine restart domain
  let restartDomain: 'control-plane' | 'http-listener' | 'web' | null = null;
  if (previousValue !== value && isRestartKey) {
    const rawCat = key.split('.')[0] as string;
    if (rawCat === 'controlPlane') restartDomain = 'control-plane';
    else if (rawCat === 'httpListener') restartDomain = 'http-listener';
    else if (rawCat === 'web') restartDomain = 'web';
  }

  // Fire change callback
  let effectMessage: string | null = null;
  if (previousValue !== value && onSettingApplied) {
    const result = onSettingApplied({ key, previousValue, value });
    effectMessage = result?.message ?? null;
    refreshGroups();
  }

  return { restartDomain, effectMessage, changed: previousValue !== value };
}

// ---------------------------------------------------------------------------
// persistFlagState — write a flag override to config
// ---------------------------------------------------------------------------

export function persistFlagState(
  configManager: ConfigManager,
  flagId: string,
  newState: FlagState,
  defaultState: FlagState,
): void {
  if (newState === 'killed') return; // never persist killed state

  try {
    const current = (configManager.getCategory('featureFlags') as Record<string, PersistedFlagState>) ?? {};
    if (newState === defaultState) {
      delete current[flagId];
    } else {
      current[flagId] = newState;
    }
    configManager.mergeCategory('featureFlags', current);
  } catch (e) {
    logger.error('SettingsModal: failed to persist flag state', { flagId, error: summarizeError(e) });
  }
}

// ---------------------------------------------------------------------------
// applyFlagState — toggle a feature flag (runtime + persist)
// ---------------------------------------------------------------------------

export function applyFlagState(
  flagEntry: FlagEntry,
  newState: FlagState,
  featureFlagManager: FeatureFlagManager,
  configManager: ConfigManager,
): void {
  const flag: FeatureFlag = flagEntry.flag;

  if (!flag.runtimeToggleable) {
    persistFlagState(configManager, flag.id, newState, flag.defaultState as FlagState);
    flagEntry.state = newState;
    return;
  }

  try {
    if (newState === 'enabled') {
      featureFlagManager.enable(flag.id);
    } else {
      featureFlagManager.disable(flag.id);
    }
    persistFlagState(configManager, flag.id, newState, flag.defaultState as FlagState);
    flagEntry.state = newState;
  } catch (e) {
    logger.error('SettingsModal: failed to toggle feature flag', { flag: flag.id, error: summarizeError(e) });
  }
}
