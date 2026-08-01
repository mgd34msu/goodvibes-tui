/**
 * theme-mode-config — the appearance/theme-mode preference, TUI-side.
 *
 * The preference lives at the config key `display.themeMode` (auto | dark |
 * light, default auto), stored under the existing SDK `display` section
 * alongside `display.theme` (the color palette — a separate, independent
 * concept: theme picks the palette, themeMode picks light/dark appearance).
 *
 * `display.themeMode` is a real CONFIG_SCHEMA entry (SDK 2.0.0+); this module
 * no longer carries a TUI-local synthetic descriptor for it. The settings
 * modal renders the schema's own row like every other key, and this module
 * keeps the read-side helpers (coerceThemeModeSetting,
 * resolveConfiguredThemeMode) that the renderer's runtime paths (theme.ts,
 * terminal-bg-probe.ts, ui-openers.ts) use to turn the resolved value into a
 * ThemeMode ('dark' | 'light') for actual rendering.
 *
 * This module is deliberately free of any terminal/probe state so both the
 * settings-modal data layer (input) and the probe (renderer) can import it
 * without pulling in the stateful probe class.
 */

import type { ThemeModeSetting } from './theme.ts';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** Config key backing the appearance/theme-mode preference (see module doc). */
export const THEME_MODE_CONFIG_KEY: ConfigKey = 'display.themeMode';

/**
 * Default when unset: probe the terminal background on startup. Matches the
 * CONFIG_SCHEMA default for display.themeMode (module-private: nothing
 * outside this file needs the default value directly — callers read the
 * resolved mode via coerceThemeModeSetting/resolveConfiguredThemeMode).
 */
const THEME_MODE_DEFAULT: ThemeModeSetting = 'auto';

/** Narrow an unknown config value to a valid ThemeModeSetting, else the default. */
export function coerceThemeModeSetting(raw: unknown): ThemeModeSetting {
  return raw === 'auto' || raw === 'dark' || raw === 'light' ? raw : THEME_MODE_DEFAULT;
}

/**
 * Read the configured theme-mode preference. Safe: the `display` section
 * exists in DEFAULT_CONFIG, so get() returns undefined for an unset field
 * rather than throwing, and we coerce undefined → 'auto'.
 */
export function resolveConfiguredThemeMode(
  configManager: Pick<ConfigManager, 'get'>,
): ThemeModeSetting {
  try {
    return coerceThemeModeSetting(configManager.get(THEME_MODE_CONFIG_KEY));
  } catch {
    // Defensive: any unexpected resolvePath/section error → honest default.
    return THEME_MODE_DEFAULT;
  }
}
