/**
 * SettingsModal — state management for the /settings config browser modal.
 *
 * Loads CONFIG_SCHEMA, groups settings by category, and tracks UI state:
 *   - Active category (Tab to cycle)
 *   - Selected setting index within category (↑↓)
 *   - Editing mode for inline string/number input
 *
 * Saves changes via configManager.set(key, value).
 */

import { CONFIG_SCHEMA, type ConfigSetting, type ConfigKey, type PersistedFlagState } from '../config/schema.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.ts';
import type { FeatureFlag, FlagState } from '../runtime/feature-flags/types.ts';
import { FEATURE_FLAGS } from '../runtime/feature-flags/flags.ts';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingsCategory = 'display' | 'provider' | 'behavior' | 'permissions' | 'danger' | 'tools' | 'flags';

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  'display',
  'provider',
  'behavior',
  'permissions',
  'danger',
  'tools',
  'flags',
];

export interface SettingEntry {
  setting: ConfigSetting;
  currentValue: unknown;
  isDefault: boolean;
}

/**
 * Represents a feature flag entry in the settings modal flags category.
 */
export interface FlagEntry {
  /** The flag's static declaration. */
  flag: FeatureFlag;
  /** Current runtime state of the flag. */
  state: FlagState;
}

// ---------------------------------------------------------------------------
// SettingsModal
// ---------------------------------------------------------------------------

export class SettingsModal {
  public active = false;

  /** Index into SETTINGS_CATEGORIES. */
  public categoryIndex = 0;

  /** Selected setting index within the current category. */
  public selectedIndex = 0;

  /** Whether we're in inline edit mode for the selected string/number setting. */
  public editingMode = false;

  /** Current value of the inline edit buffer. */
  public editBuffer = '';

  /** Settings grouped by category (excludes 'flags'). */
  public groups: Map<SettingsCategory, SettingEntry[]> = new Map();

  /** Feature flag entries for the 'flags' category. */
  public flagEntries: FlagEntry[] = [];

  private configManager: ConfigManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   *
   * @param configManager - The config manager to read and write settings.
   * @param featureFlagManager - Feature flag manager for the flags category.
   */
  open(configManager: ConfigManager, featureFlagManager: FeatureFlagManager): void {
    this.configManager = configManager;
    this.featureFlagManager = featureFlagManager;
    this._loadGroups(configManager);
    this._loadFlagEntries();
    this.categoryIndex = 0;
    this.selectedIndex = 0;
    this.editingMode = false;
    this.editBuffer = '';
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.editingMode = false;
    this.editBuffer = '';
  }

  /** Cycle to the next category (Tab). */
  nextCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
  }

  moveUp(): void {
    if (this.editingMode) return;
    if (this.currentCategory === 'flags') {
      if (this.flagEntries.length === 0) return;
      this.selectedIndex = (this.selectedIndex - 1 + this.flagEntries.length) % this.flagEntries.length;
      return;
    }
    const items = this._currentItems();
    if (items.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
  }

  moveDown(): void {
    if (this.editingMode) return;
    if (this.currentCategory === 'flags') {
      if (this.flagEntries.length === 0) return;
      this.selectedIndex = (this.selectedIndex + 1) % this.flagEntries.length;
      return;
    }
    const items = this._currentItems();
    if (items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
  }

  getSelected(): SettingEntry | null {
    if (this.currentCategory === 'flags') return null;
    return this._currentItems()[this.selectedIndex] ?? null;
  }

  /**
   * Returns the currently selected feature flag entry, or null if not in the 'flags' category.
   */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    return this.flagEntries[this.selectedIndex] ?? null;
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  /** Returns current settings entries (empty when in 'flags' category). */
  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   * In the 'flags' category, toggles the selected feature flag.
   */
  activateSelected(): void {
    if (this.currentCategory === 'flags') {
      this.toggleSelectedFlag();
      return;
    }

    const entry = this.getSelected();
    if (!entry || !this.configManager) return;

    const { setting } = entry;

    if (setting.type === 'boolean') {
      const newVal = !entry.currentValue;
      this._setValue(setting.key, newVal);
    } else if (setting.type === 'enum' && setting.enumValues) {
      const idx = setting.enumValues.indexOf(entry.currentValue as string);
      const nextIdx = (idx + 1) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIdx]);
    } else if (setting.type === 'string' || setting.type === 'number') {
      // Enter inline edit mode
      this.editingMode = true;
      this.editBuffer = String(entry.currentValue ?? '');
    }
  }

  /**
   * Toggle the selected feature flag between enabled and disabled.
   *
   * Skips killed flags (cannot be toggled from the UI).
   * Applies the change in-memory immediately and persists to config.
   */
  toggleSelectedFlag(): void {
    const entry = this.getSelectedFlag();
    if (!entry || !this.featureFlagManager || !this.configManager) return;

    const { flag, state } = entry;

    // Killed flags are not toggleable from the UI
    if (state === 'killed') return;

    // Non-runtime-toggleable flags cannot be changed after startup
    if (!flag.runtimeToggleable) return;

    try {
      const newState: FlagState = state === 'enabled' ? 'disabled' : 'enabled';

      if (newState === 'enabled') {
        this.featureFlagManager.enable(flag.id);
      } else {
        this.featureFlagManager.disable(flag.id);
      }

      // Update cached entry in-place
      entry.state = newState;

      // Persist to config — only store non-default states to keep config clean
      this._persistFlagState(flag.id, newState);
    } catch (e) {
      logger.error('SettingsModal: failed to toggle feature flag', { flagId: flag.id, error: String(e) });
    }
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true on success, false if validation failed.
   */
  commitEdit(): boolean {
    const entry = this.getSelected();
    if (!entry || !this.configManager || !this.editingMode) return false;

    const { setting } = entry;
    let parsed: unknown = this.editBuffer;

    if (setting.type === 'number') {
      parsed = Number(this.editBuffer);
      if (isNaN(parsed as number)) {
        this.editingMode = false;
        this.editBuffer = '';
        return false;
      }
    }

    if (setting.validate && !setting.validate(parsed)) {
      this.editingMode = false;
      this.editBuffer = '';
      return false;
    }

    this._setValue(setting.key, parsed);
    this.editingMode = false;
    this.editBuffer = '';
    return true;
  }

  /** Cancel inline edit without saving. */
  cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
  }

  /** Handle a keystroke in edit mode: regular chars appended, Backspace removes last char. */
  editChar(char: string): void {
    if (!this.editingMode) return;
    this.editBuffer += char;
  }

  editBackspace(): void {
    if (!this.editingMode) return;
    this.editBuffer = this.editBuffer.slice(0, -1);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _loadGroups(configManager: ConfigManager): void {
    this.groups.clear();
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') continue; // flags are managed separately via flagEntries
      this.groups.set(cat, []);
    }

    for (const setting of CONFIG_SCHEMA) {
      const cat = setting.key.split('.')[0] as SettingsCategory;
      if (!this.groups.has(cat)) continue;
      const currentValue = configManager.get(setting.key as ConfigKey);
      const entry: SettingEntry = {
        setting,
        currentValue,
        isDefault: currentValue === setting.default,
      };
      this.groups.get(cat)!.push(entry);
    }
  }

  /**
   * Load the current state of all registered feature flags from the manager.
   * Falls back to default states when no manager is available.
   */
  private _loadFlagEntries(): void {
    this.flagEntries = FEATURE_FLAGS.map((flag) => {
      const state: FlagState = this.featureFlagManager
        ? this.featureFlagManager.getState(flag.id)
        : flag.defaultState;
      return { flag, state };
    });
  }

  private _currentItems(): SettingEntry[] {
    if (this.currentCategory === 'flags') return [];
    return this.groups.get(this.currentCategory) ?? [];
  }

  private _setValue(key: ConfigKey, value: unknown): void {
    if (!this.configManager) return;
    try {
      this.configManager.setDynamic(key, value);
      // Update the cached entry in-place — avoids full schema re-scan on each edit
      const cat = key.split('.')[0] as SettingsCategory;
      const entries = this.groups.get(cat);
      if (entries) {
        const entry = entries.find(e => e.setting.key === key);
        if (entry) {
          entry.currentValue = this.configManager!.get(key);
          entry.isDefault = entry.currentValue === entry.setting.default;
        }
      }
    } catch (e) {
      logger.error('SettingsModal: failed to set config value', { key, error: String(e) });
    }
  }

  /**
   * Persist a flag state change to the config file.
   *
   * Only stores 'enabled' and 'disabled' states (not 'killed' — kill is
   * an operator action, not a user config preference). Removes the key
   * when the flag reverts to its default state to keep the config clean.
   *
   * @param flagId - The flag's kebab-case identifier.
   * @param state - The new flag state to persist.
   */
  private _persistFlagState(flagId: string, state: FlagState): void {
    if (!this.configManager) return;
    if (state === 'killed') return; // killed state is not user-persisted

    try {
      const current = this.configManager.getCategory('featureFlags') ?? {};
      const updated: Record<string, PersistedFlagState> = { ...current };

      const flag = FEATURE_FLAGS.find(f => f.id === flagId);
      if (flag && state === flag.defaultState) {
        delete updated[flagId];
      } else {
        updated[flagId] = state as PersistedFlagState;
      }

      this.configManager.mergeCategory('featureFlags', updated);
    } catch (e) {
      logger.error('SettingsModal: failed to persist flag state', { flagId, error: String(e) });
    }
  }
}
