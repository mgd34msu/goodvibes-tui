/**
 * settings-modal-reset — pure reset helpers for SettingsModal.
 *
 * These functions encapsulate the three reset operations:
 *   - resetSelected: reset the currently selected setting to its schema default
 *   - initiateResetCategory: arm the category-reset confirmation gate
 *   - initiateResetAll: arm the reset-all confirmation gate
 *   - handleResetConfirmKey: route a keypress through the active gate
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state. resetCategoryConfirm and resetAllConfirm
 * remain public class fields on SettingsModal — the renderer reads them
 * directly to decide the footer state.
 */

import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { buildGoodVibesSecretKey, defaultSecretBackedScope, isSecretConfigKey } from '../config/secret-config.ts';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';
import type { SettingsSecretsManager } from './settings-modal-secrets.ts';

// ---------------------------------------------------------------------------
// resetSelected
// ---------------------------------------------------------------------------

export function resetSelected({
  editingMode,
  hasConfigManager,
  selected,
  secretsManager,
  setValue,
}: {
  editingMode: boolean;
  hasConfigManager: boolean;
  selected: SettingEntry | null;
  secretsManager: SettingsSecretsManager | null;
  setValue: (key: ConfigKey, value: unknown) => void;
}): { key: ConfigKey; value: unknown } | null {
  if (editingMode || !hasConfigManager) return null;
  if (!selected) return null;
  const key = selected.setting.key as ConfigKey;
  setValue(key, selected.setting.default);
  if (isSecretConfigKey(key) && secretsManager) {
    void secretsManager.delete(buildGoodVibesSecretKey(key), { scope: defaultSecretBackedScope(key) }).catch((error) => {
      logger.error('SettingsModal: failed to clear secret while resetting setting', { key, error: summarizeError(error) });
    });
  }
  return { key, value: selected.setting.default };
}

// ---------------------------------------------------------------------------
// initiateResetCategory
// ---------------------------------------------------------------------------

export function initiateResetCategory({
  hasConfigManager,
  currentCategory,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  currentCategory: string;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetCategoryConfirm({ subject: currentCategory });
  setResetAllConfirm(null);
}

// ---------------------------------------------------------------------------
// initiateResetAll
// ---------------------------------------------------------------------------

export function initiateResetAll({
  hasConfigManager,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  hasConfigManager: boolean;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): void {
  if (!hasConfigManager) return;
  setResetAllConfirm({ subject: 'all' });
  setResetCategoryConfirm(null);
}

// ---------------------------------------------------------------------------
// handleResetConfirmKey
// ---------------------------------------------------------------------------

export type ResetConfirmKeyResult =
  | { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> }
  | 'cancelled'
  | 'absorbed'
  | 'inactive';

export function handleResetConfirmKey({
  key,
  resetCategoryConfirm,
  resetAllConfirm,
  hasConfigManager,
  currentItems,
  groups,
  setValue,
  setResetCategoryConfirm,
  setResetAllConfirm,
}: {
  key: string;
  resetCategoryConfirm: { readonly subject: string } | null;
  resetAllConfirm: { readonly subject: 'all' } | null;
  hasConfigManager: boolean;
  currentItems: () => SettingEntry[];
  groups: Map<SettingsCategory, SettingEntry[]>;
  setValue: (key: ConfigKey, value: unknown) => void;
  setResetCategoryConfirm: (value: { readonly subject: string } | null) => void;
  setResetAllConfirm: (value: { readonly subject: 'all' } | null) => void;
}): ResetConfirmKeyResult {
  const gate = resetCategoryConfirm ?? resetAllConfirm;
  if (!gate || !hasConfigManager) return 'inactive';

  if (key === 'enter' || key === 'y') {
    const entries: Array<{ key: string; value: unknown }> = [];
    if (resetCategoryConfirm) {
      // Reset all settings in the current category to defaults.
      const items = currentItems();
      for (const item of items) {
        setValue(item.setting.key as ConfigKey, item.setting.default);
        entries.push({ key: item.setting.key, value: item.setting.default });
      }
      setResetCategoryConfirm(null);
    } else {
      // Reset ALL settings across all categories to defaults.
      for (const [, items] of groups) {
        for (const item of items) {
          setValue(item.setting.key as ConfigKey, item.setting.default);
          entries.push({ key: item.setting.key, value: item.setting.default });
        }
      }
      setResetAllConfirm(null);
    }
    return { result: 'confirmed', entries };
  }

  if (key === 'escape' || key === 'n') {
    setResetCategoryConfirm(null);
    setResetAllConfirm(null);
    return 'cancelled';
  }

  // All other keys are absorbed while the gate is active.
  return 'absorbed';
}
