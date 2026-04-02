/**
 * SettingsModal — state management for the /settings config browser modal.
 *
 * Loads CONFIG_SCHEMA, groups settings by category, and tracks UI state:
 *   - Active category (Tab to cycle)
 *   - Selected setting index within category (↑↓)
 *   - Editing mode for inline string/number input
 *   - Feature flags tab with runtime toggle support
 *
 * Saves changes via configManager.set(key, value) or featureFlagManager methods.
 */

import { CONFIG_SCHEMA, type ConfigSetting, type ConfigKey, type PersistedFlagState } from '../config/schema.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.ts';
import type { FeatureFlag, FlagState } from '../runtime/feature-flags/types.ts';
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

/** A single feature flag entry for the flags tab. */
export interface FlagEntry {
  flag: FeatureFlag;
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

  /** Settings grouped by category. */
  public groups: Map<SettingsCategory, SettingEntry[]> = new Map();

  /** Feature flag entries (populated when flags tab is active). */
  public flagEntries: FlagEntry[] = [];

  private configManager: ConfigManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   *
   * @param configManager - Config manager instance for reading/writing settings.
   * @param featureFlagManager - Feature flag manager for the flags tab.
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
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    }
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    }
  }

  moveUp(): void {
    if (this.editingMode) return;
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.flagEntries.length) % this.flagEntries.length;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
  }

  moveDown(): void {
    if (this.editingMode) return;
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.flagEntries.length;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
  }

  getSelected(): SettingEntry | null {
    return this._currentItems()[this.selectedIndex] ?? null;
  }

  /** Get the currently selected flag entry (flags tab only). */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    return this.flagEntries[this.selectedIndex] ?? null;
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   */
  activateSelected(): void {
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
   * Toggle the currently selected feature flag.
   *
   * Killed flags cannot be toggled. Non-runtimeToggleable flags toggle in config
   * only (require restart). runtimeToggleable flags toggle immediately.
   */
  toggleSelectedFlag(): void {
    const flagEntry = this.getSelectedFlag();
    if (!flagEntry || !this.featureFlagManager || !this.configManager) return;

    const { flag, state } = flagEntry;

    // Killed flags are blocked
    if (state === 'killed') return;

    const newState: FlagState = state === 'enabled' ? 'disabled' : 'enabled';

    if (!flag.runtimeToggleable) {
      // Persist to config only — takes effect on restart
      this._persistFlagState(flag.id, newState, flag.defaultState as FlagState);
      flagEntry.state = newState;
    } else {
      // Toggle immediately in manager
      try {
        if (newState === 'enabled') {
          this.featureFlagManager.enable(flag.id);
        } else {
          this.featureFlagManager.disable(flag.id);
        }
        this._persistFlagState(flag.id, newState, flag.defaultState as FlagState);
        flagEntry.state = newState;
      } catch (e) {
        logger.error('SettingsModal: failed to toggle feature flag', { flag: flag.id, error: String(e) });
      }
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

  // ── Private helpers ────────────────────────────────────────────

  private _loadGroups(configManager: ConfigManager): void {
    this.groups.clear();
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') continue; // flags tab handled separately
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

  /** Load or refresh the flags tab entries from the feature flag manager. */
  private _loadFlagEntries(): void {
    if (!this.featureFlagManager) {
      this.flagEntries = [];
      return;
    }
    this.flagEntries = Array.from(this.featureFlagManager.getAll().values()).map(({ flag, state }) => ({
      flag,
      state,
    }));
  }

  /**
   * Persist a flag state override to config.
   * Deletes the entry when reverting to defaultState. Skips killed state.
   */
  private _persistFlagState(flagId: string, newState: FlagState, defaultState: FlagState): void {
    if (!this.configManager) return;
    if (newState === 'killed') return; // never persist killed state

    try {
      const current = (this.configManager.getCategory('featureFlags') as Record<string, PersistedFlagState>) ?? {};
      if (newState === defaultState) {
        // Revert to default — remove override
        delete current[flagId];
      } else {
        current[flagId] = newState;
      }
      this.configManager.mergeCategory('featureFlags', current);
    } catch (e) {
      logger.error('SettingsModal: failed to persist flag state', { flagId, error: String(e) });
    }
  }

  /** Returns [] for the flags category (flags use flagEntries instead). */
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
}
