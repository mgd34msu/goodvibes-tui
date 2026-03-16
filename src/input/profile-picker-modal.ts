/**
 * ProfilePickerModal — state management for the /profiles picker modal.
 *
 * Lists profiles from ProfileManager.list(), tracks selected index,
 * and handles load/delete/save actions.
 */

import { getProfileManager, type ProfileInfo, type ProfileData } from '../profiles/manager.ts';
import { logger } from '../utils/logger.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ConfigKey } from '../config/schema.ts';

/** Known display setting keys (subset of ConfigKey that maps to display.*). */
const DISPLAY_KEYS: ConfigKey[] = [
  'display.stream', 'display.lineNumbers', 'display.collapseThreshold',
  'display.theme', 'display.showThinking', 'display.showReasoningSummary',
  'display.showTokenSpeed', 'display.showToolPreview',
] as const;

/** Known behavior setting keys (subset of ConfigKey that maps to behavior.*). */
const BEHAVIOR_KEYS: ConfigKey[] = [
  'behavior.autoApprove', 'behavior.autoCompactThreshold',
  'behavior.saveHistory', 'behavior.notifyOnComplete',
] as const;

/**
 * Apply a profile data category to the config manager.
 * Iterates only known/valid keys rather than open-ended Object.entries.
 */
function applyProfileCategory(
  cm: ConfigManager,
  data: Record<string, unknown>,
  keys: ConfigKey[],
): void {
  for (const key of keys) {
    const field = key.split('.')[1];
    if (field && Object.prototype.hasOwnProperty.call(data, field)) {
      try {
        cm.setDynamic(key, data[field]);
      } catch (e) { logger.debug('applyProfileCategory: key set failed', { key, error: String(e) }); }
    }
  }
}

// ---------------------------------------------------------------------------
// ProfilePickerModal
// ---------------------------------------------------------------------------

export class ProfilePickerModal {
  public active = false;
  public profiles: ProfileInfo[] = [];
  public selectedIndex = 0;

  /** Last status message (success/error feedback). */
  public statusMessage = '';

  /**
   * Open the modal, loading profiles from ProfileManager.
   */
  open(): void {
    const manager = getProfileManager();
    this.profiles = manager.list();
    this.selectedIndex = 0;
    this.statusMessage = '';
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
  }

  moveUp(): void {
    if (this.profiles.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.profiles.length) % this.profiles.length;
  }

  moveDown(): void {
    if (this.profiles.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.profiles.length;
  }

  getSelected(): ProfileInfo | null {
    return this.profiles[this.selectedIndex] ?? null;
  }

  /**
   * Load the selected profile into configManager.
   * Returns true on success, false on error.
   */
  loadSelected(configManager: ConfigManager): boolean {
    const profile = this.getSelected();
    if (!profile) return false;

    try {
      const manager = getProfileManager();
      const { data } = manager.load(profile.name);

      // Apply display settings using validated key list
      if (data.display) {
        applyProfileCategory(configManager, data.display as Record<string, unknown>, DISPLAY_KEYS);
      }

      // Apply provider settings (model + reasoningEffort only)
      if (data.provider) {
        if (data.provider.model !== undefined) {
          try { configManager.set('provider.model', data.provider.model); } catch (e) { logger.debug('profile: model set failed', { error: String(e) }); }
        }
        if (data.provider.reasoningEffort !== undefined) {
          try { configManager.set('provider.reasoningEffort', data.provider.reasoningEffort); } catch (e) { logger.debug('profile: reasoningEffort set failed', { error: String(e) }); }
        }
      }

      // Apply behavior settings using validated key list
      if (data.behavior) {
        applyProfileCategory(configManager, data.behavior as Record<string, unknown>, BEHAVIOR_KEYS);
      }

      configManager.save();
      this.statusMessage = `Loaded profile: ${profile.name}`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }

  /**
   * Delete the selected profile from disk.
   * Refreshes the list after deletion.
   */
  deleteSelected(): boolean {
    const profile = this.getSelected();
    if (!profile) return false;

    try {
      const manager = getProfileManager();
      const deleted = manager.delete(profile.name);
      if (!deleted) {
        this.statusMessage = `Profile not found: ${profile.name}`;
        return false;
      }
      this.profiles = manager.list();
      if (this.selectedIndex >= this.profiles.length) {
        this.selectedIndex = Math.max(0, this.profiles.length - 1);
      }
      this.statusMessage = `Deleted: ${profile.name}`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }

  /**
   * Save the current config settings as a new profile under `name`.
   */
  saveCurrentAs(name: string, configManager: ConfigManager): boolean {
    if (!name || !name.trim()) {
      this.statusMessage = 'Profile name cannot be empty';
      return false;
    }

    try {
      const all = configManager.getAll();
      const data: ProfileData = {
        display: { ...all.display },
        provider: {
          model: all.provider.model,
          reasoningEffort: all.provider.reasoningEffort,
        },
        behavior: { ...all.behavior },
      };

      const manager = getProfileManager();
      manager.save(name, data);

      // Reload list
      this.profiles = manager.list();
      this.statusMessage = `Saved profile: ${name}`;
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${(e as Error).message}`;
      return false;
    }
  }
}
