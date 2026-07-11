/**
 * relay-settings-descriptions.ts — appends the relay threat-model one-liner to
 * the `relay.*` CONFIG_SCHEMA descriptions shown in /config and the settings
 * modal.
 *
 * `relay.*` is a real SDK CONFIG_SCHEMA domain (schema-domain-runtime.ts) —
 * the settings-modal-data.ts CONFIG_SCHEMA loop already surfaces it once
 * `relay` is listed in SETTINGS_CATEGORIES (see settings-modal-types.ts). The
 * SDK's own descriptions explain WHAT each key does but not the trust
 * boundary the outbound relay path crosses; this enrichment appends that
 * honestly, once, without duplicating or overriding the SDK's wording. Entries
 * are shallow-cloned (never mutating the shared `ConfigSetting` objects the
 * SDK exports from CONFIG_SCHEMA) so re-running this on the same groups map
 * is idempotent.
 */

import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

/** The threat-model note every relay.* setting description gets appended with. */
export const RELAY_THREAT_MODEL_NOTE =
  'The relay operator sees only ciphertext and connection metadata — it cannot read message contents. Self-host your own relay for full control.';

/** Append the threat-model note to every relay.* entry's description, in place. */
export function enrichRelaySettingDescriptions(groups: Map<SettingsCategory, SettingEntry[]>): void {
  const relayEntries = groups.get('relay');
  if (!relayEntries) return;
  for (let i = 0; i < relayEntries.length; i++) {
    const entry = relayEntries[i];
    if (!entry || !entry.setting.key.startsWith('relay.') || entry.setting.description.includes(RELAY_THREAT_MODEL_NOTE)) continue;
    relayEntries[i] = {
      ...entry,
      setting: { ...entry.setting, description: `${entry.setting.description} ${RELAY_THREAT_MODEL_NOTE}` },
    };
  }
}
