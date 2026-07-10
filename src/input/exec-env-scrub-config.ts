/**
 * exec-env-scrub-config.ts — TUI-local synthetic settings entry for
 * permissions.execEnvScrubAllowlist.
 *
 * The SDK's credential-bearing env-var scrub (platform/tools/exec/credential-env.ts)
 * removes well-known credential-bearing variable NAMES (AWS_SECRET_ACCESS_KEY,
 * GITHUB_TOKEN, OPENAI_API_KEY, …) from the environment handed to every spawned
 * exec command, and is threaded into `registerAllTools`'s `credentialEnvScrub`
 * option (bootstrap-core.ts) so a consumer can wire an operator-configured
 * allowlist instead of the scrub always resolving to its built-in default. The
 * scrub's master switch stays on: this entry configures ONLY the allowlist —
 * variable NAMES always kept even though their name looks credential-bearing
 * (case-insensitive), for a command that genuinely needs one (e.g. a CI runner
 * re-reading its own signing key). NEVER a value; the scrub only ever inspects
 * and reports NAMES.
 *
 * `permissions.execEnvScrubAllowlist` is not in CONFIG_SCHEMA — there is no SDK
 * config domain for the exec env scrub at all (it is consumer-wired, not
 * schema-registered), so this mirrors the other TUI-local synthetic settings
 * (worktree.setup.*, sandbox.egressAllowlist, …). No defensive try/catch is
 * needed: 'permissions' already exists as a DEFAULT_CONFIG section (it backs
 * permissions.mode/tools.*), so a plain get()/set() resolves the path without
 * throwing — only the LEAF field is new, and ConfigManager.resolvePath never
 * validates leaf existence.
 *
 * Stored as a JSON array of strings on disk; the settings modal's inline
 * editor is a single-line text field, so — matching worktree.setup.* and
 * sandbox.egressAllowlist/workspaceWritable — it is displayed and edited as a
 * comma-separated list and parsed back into an array on commit (see
 * isExecEnvScrubAllowlistConfigKey's use in settings-modal.ts#commitEdit).
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

export const EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY = 'permissions.execEnvScrubAllowlist' as ConfigKey;

/** True for the exec env-scrub allowlist key, whose stored value is a string array edited as a comma-separated list. */
export function isExecEnvScrubAllowlistConfigKey(key: ConfigKey): boolean {
  return key === EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY;
}

/** Read the allowlist as a string array (non-array/malformed/unset degrades to empty). */
export function readExecEnvScrubAllowlist(configManager: Pick<ConfigManager, 'get'>): string[] {
  const raw = configManager.get(EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Parse a comma-separated edit-buffer submission back into a string array (trimmed, empties dropped). Same convention as worktree.setup.* / sandbox.egressAllowlist. */
export function parseExecEnvScrubAllowlistInput(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export const EXEC_ENV_SCRUB_ALLOWLIST_SYNTHETIC_SETTING: ConfigSetting = {
  key: EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated environment variable NAMES always kept in a spawned exec command\'s environment even when the name looks credential-bearing (case-insensitive). Names only — this never inspects or reports values. The scrub itself stays on; this only widens what it lets through. Empty = the built-in credential-name scrub applies with no extra exceptions.',
};

/** Build the synthetic SettingEntry for permissions.execEnvScrubAllowlist. */
export function buildExecEnvScrubAllowlistSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const currentValue = readExecEnvScrubAllowlist(configManager);
  return {
    setting: EXEC_ENV_SCRUB_ALLOWLIST_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue.length === 0,
  };
}

/**
 * Inject the synthetic entry into the permissions category's SettingEntry
 * list, idempotently. No-op when the category isn't present in `groups`.
 */
export function injectExecEnvScrubSyntheticEntry(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: Pick<ConfigManager, 'get'>,
): void {
  const permissionsEntries = groups.get('permissions');
  if (!permissionsEntries) return;
  if (!permissionsEntries.some((e) => e.setting.key === EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)) {
    permissionsEntries.push(buildExecEnvScrubAllowlistSyntheticEntry(configManager));
  }
}
