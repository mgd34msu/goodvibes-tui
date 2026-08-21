/**
 * daemon-owned-settings-descriptions.ts, appends an honest storage-location
 * note to any settings-modal entry whose config key is daemon-owned (see
 * `@pellux/goodvibes-sdk/platform/config`'s `isDaemonOwnedConfigKey`).
 *
 * Before the daemon-owned-config migration, every product wrote every key
 * into its own per-surface silo, and a value like `surfaces.telegram.token`
 * looked, from the settings modal, exactly like any other TUI-local
 * setting. It never was: the daemon is the only process that reads it, so a
 * value the TUI wrote to its own surface file could silently do nothing.
 * This enrichment tells the truth in the one place a user checks: the
 * setting's own detail text says the value lives in the daemon's store and
 * applies to every client, naming the actual file path via
 * `ConfigManager.getDaemonTierPath()`.
 *
 * Entries are shallow-cloned (never mutating the shared `ConfigSetting`
 * objects CONFIG_SCHEMA exports), following the same pattern as
 * relay-settings-descriptions.ts, so re-running this on the same groups map
 * stays idempotent.
 */

import { isDaemonOwnedConfigKey, type ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

/** Build the daemon-owned disclosure note for a given daemon store path. */
export function daemonOwnedSettingNote(daemonTierPath: string | null): string {
  return daemonTierPath
    ? `This value is stored in the daemon's own configuration (${daemonTierPath}) and applies to every client; not just this one.`
    : "This value is stored in the daemon's own configuration and applies to every client; not just this one.";
}

/**
 * Append the daemon-owned disclosure note to every entry whose config key is
 * daemon-owned, across every category in `groups`, in place.
 */
export function enrichDaemonOwnedSettingDescriptions(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: Pick<ConfigManager, 'getDaemonTierPath'>,
): void {
  const note = daemonOwnedSettingNote(configManager.getDaemonTierPath());
  for (const entries of groups.values()) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      if (!isDaemonOwnedConfigKey(entry.setting.key)) continue;
      if (entry.setting.description.includes(note)) continue;
      entries[i] = {
        ...entry,
        setting: { ...entry.setting, description: `${entry.setting.description} ${note}` },
      };
    }
  }
}
