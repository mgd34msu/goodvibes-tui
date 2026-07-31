/**
 * theme-mode-config — the appearance/theme-mode preference, TUI-side.
 *
 * The preference lives at the config key `display.themeMode` (auto | dark |
 * light, default auto). It is stored under the existing SDK `display` section
 * rather than a new `appearance` section on purpose: the SDK ConfigManager's
 * resolvePath() throws for any dot-path whose top-level section is absent from
 * DEFAULT_CONFIG, and adding an `appearance` section would require an SDK schema
 * change (out of scope for this TUI-only work order). Storing under `display`
 * reuses the same proven "TUI-local synthetic setting" pattern the codebase
 * already uses for behavior.notifyAfterSeconds / storage.codeIndexEnabled:
 * ConfigManager.setDynamic writes it to settings.json and get() reads it back,
 * with zero SDK changes.
 *
 * This module is deliberately free of any terminal/probe state so both the
 * settings-modal data layer (input) and the probe (renderer) can import it
 * without pulling in the stateful probe class.
 */

import type { ThemeModeSetting } from './theme.ts';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** Config key backing the appearance/theme-mode preference (see module doc). */
export const THEME_MODE_CONFIG_KEY = 'display.themeMode';

/** The three valid preference values, in settings-cycle order. */
export const THEME_MODE_VALUES: readonly ThemeModeSetting[] = ['auto', 'dark', 'light'];

/** Default when unset: probe the terminal background on startup. */
export const THEME_MODE_DEFAULT: ThemeModeSetting = 'auto';

/**
 * Human-facing description for the settings-modal entry. States the honest
 * timing contract: forced modes apply on next full paint immediately; `auto`
 * only re-probes at startup, so switching TO auto takes effect next launch.
 */
export const THEME_MODE_DESCRIPTION =
  'Terminal background theme. auto probes the terminal background colour once at '
  + 'startup (OSC 11) and picks light or dark; dark/light force a fixed theme. '
  + 'Forced modes take effect immediately; auto is only evaluated at startup, so '
  + 'selecting auto takes effect on the next launch. Unreadable/unsupported '
  + 'terminals fall back to dark. Scope (honest): transcript markdown, modal '
  + 'accents, and the header/footer/thinking chrome all flip with this setting; '
  + 'only the background colour itself follows your terminal.';

/** Narrow an unknown config value to a valid ThemeModeSetting, else the default. */
export function coerceThemeModeSetting(raw: unknown): ThemeModeSetting {
  return raw === 'auto' || raw === 'dark' || raw === 'light' ? raw : THEME_MODE_DEFAULT;
}

/**
 * Read the configured theme-mode preference. Reads the TUI-local key via a cast
 * (it is not in the SDK ConfigKey union). Safe: the `display` section exists in
 * DEFAULT_CONFIG, so get() returns undefined for the absent field rather than
 * throwing, and we coerce undefined → 'auto'.
 */
export function resolveConfiguredThemeMode(
  configManager: Pick<ConfigManager, 'get'>,
): ThemeModeSetting {
  try {
    // Cast key: display.themeMode is TUI-local, not in the SDK ConfigKey union.
    return coerceThemeModeSetting(configManager.get(THEME_MODE_CONFIG_KEY as ConfigKey));
  } catch {
    // Defensive: any unexpected resolvePath/section error → honest default.
    return THEME_MODE_DEFAULT;
  }
}
