/**
 * ProfilePickerModal — state management for the /profiles picker modal.
 *
 * Lists profiles from ProfileManager.list(), tracks selected index,
 * and handles load/delete/save actions.
 */

import type { ProfileInfo, ProfileData, ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

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
      } catch (e) { logger.debug('applyProfileCategory: key set failed', { key, error: summarizeError(e) }); }
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
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;

  /** Last status message (success/error feedback). */
  public statusMessage = '';

  public constructor(private readonly profileManager: ProfileManager) {}

  /**
   * Open the modal, loading profiles from ProfileManager.
   */
  open(): void {
    this.profiles = this.profileManager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
  }

  moveUp(): void {
    if (this.profiles.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.profiles.length) % this.profiles.length;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  moveDown(): void {
    if (this.profiles.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.profiles.length;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }

  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
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
      const { data } = this.profileManager.load(profile.name);

      // Apply display settings using validated key list
      if (data.display) {
        applyProfileCategory(configManager, data.display as Record<string, unknown>, DISPLAY_KEYS);
      }

      // Apply provider settings (model + reasoningEffort only)
      if (data.provider) {
        if (data.provider.model !== undefined) {
          try { configManager.set('provider.model', data.provider.model); } catch (e) { logger.debug('profile: model set failed', { error: summarizeError(e) }); }
        }
        if (data.provider.reasoningEffort !== undefined) {
          try { configManager.set('provider.reasoningEffort', data.provider.reasoningEffort); } catch (e) { logger.debug('profile: reasoningEffort set failed', { error: summarizeError(e) }); }
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
      this.statusMessage = `Error: ${summarizeError(e)}`;
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
    if (this.deleteConfirmationTarget !== profile.name) {
      this.deleteConfirmationTarget = profile.name;
      this.statusMessage = `Press delete again to remove profile: ${profile.name}`;
      return false;
    }

    try {
      const deleted = this.profileManager.delete(profile.name);
      if (!deleted) {
        this.statusMessage = `Profile not found: ${profile.name}`;
        this.deleteConfirmationTarget = null;
        return false;
      }
      this.profiles = this.profileManager.list();
      if (this.selectedIndex >= this.profiles.length) {
        this.selectedIndex = Math.max(0, this.profiles.length - 1);
      }
      this._clampScroll();
      this.deleteConfirmationTarget = null;
      this.statusMessage = `Deleted: ${profile.name}`;
      return true;
    } catch (e) {
      this.deleteConfirmationTarget = null;
      this.statusMessage = `Error: ${summarizeError(e)}`;
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

      this.profileManager.save(name, data);

      // Reload list
      this.profiles = this.profileManager.list();
      this.statusMessage = `Saved profile: ${name}`;
      this._clampScroll();
      return true;
    } catch (e) {
      this.statusMessage = `Error: ${summarizeError(e)}`;
      return false;
    }
  }

  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.profiles.length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
