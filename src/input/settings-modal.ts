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

import { CONFIG_SCHEMA, type ConfigSetting, type ConfigKey } from '../config/schema.ts';
import type { ConfigManager } from '../config/manager.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettingsCategory = 'display' | 'provider' | 'behavior' | 'permissions' | 'danger' | 'tools';

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  'display',
  'provider',
  'behavior',
  'permissions',
  'danger',
  'tools',
];

export interface SettingEntry {
  setting: ConfigSetting;
  currentValue: unknown;
  isDefault: boolean;
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

  private configManager: ConfigManager | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   */
  open(configManager: ConfigManager): void {
    this.configManager = configManager;
    this._loadGroups(configManager);
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
    const items = this._currentItems();
    if (items.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
  }

  moveDown(): void {
    if (this.editingMode) return;
    const items = this._currentItems();
    if (items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
  }

  getSelected(): SettingEntry | null {
    return this._currentItems()[this.selectedIndex] ?? null;
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

  private _currentItems(): SettingEntry[] {
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
      console.warn('SettingsModal._setValue: config set rejected', { error: String(e) });
    }
  }
}
