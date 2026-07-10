/**
 * worktree-setup-config.ts — TUI-local synthetic settings entries for
 * worktree.setup.commands / worktree.setup.carryOverGlobs.
 *
 * Neither key is in the SDK's ConfigKey union: the SDK's cold-start worktree
 * setup (platform/runtime/worktree/setup.ts, resolveWorktreeSetupConfig)
 * reads them off a generic `get(key: string)` rather than the typed
 * CONFIG_SCHEMA, so without this file they are invisible to /config and the
 * settings modal even though they fully control what runs when a fresh
 * isolated worktree is provisioned (setup commands, then untracked-file
 * carry-over). Same rationale as the other synthetic settings in
 * settings-modal-data.ts (tts.speed, behavior.notifyAfterSeconds, etc).
 *
 * Both keys hold a JSON array of strings on disk. The settings modal's
 * inline editor is a single-line text field, so — matching the SDK's own
 * convention for controlPlane.cors.allowedOrigins — they are displayed and
 * edited as a comma-separated list and parsed back into an array on commit
 * (see isWorktreeSetupListConfigKey's use in settings-modal.ts#commitEdit).
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { SettingEntry } from './settings-modal-types.ts';

export const WORKTREE_SETUP_COMMANDS_CONFIG_KEY = 'worktree.setup.commands' as ConfigKey;
export const WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY = 'worktree.setup.carryOverGlobs' as ConfigKey;

const WORKTREE_SETUP_LIST_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set([
  WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
  WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY,
]);

/** True for the two worktree-setup keys, whose stored value is a string array edited as a comma-separated list. */
export function isWorktreeSetupListConfigKey(key: ConfigKey): boolean {
  return WORKTREE_SETUP_LIST_CONFIG_KEYS.has(key);
}

/**
 * Read a config value as a string array — mirrors the SDK's own tolerant
 * readStringArray (non-array/malformed degrades to empty).
 *
 * Defensive try/catch (now belt-and-suspenders): the SDK registers the
 * `worktree` section in DEFAULT_CONFIG (setup.commands / setup.carryOverGlobs,
 * both empty lists) as of this repack, so ConfigManager.get no longer throws
 * for these keys on a fresh store. The guard is retained so an older SDK — or
 * a config store whose section was pruned — degrades to an empty list here
 * (this read runs on every settings-modal build) rather than crashing /config
 * or /settings.
 */
export function readWorktreeSetupList(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string[] {
  let raw: unknown;
  try {
    raw = configManager.get(key);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Parse a comma-separated edit-buffer submission back into a string array (trimmed, empties dropped). */
export function parseWorktreeSetupListInput(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export const WORKTREE_SETUP_COMMANDS_SYNTHETIC_SETTING: ConfigSetting = {
  key: WORKTREE_SETUP_COMMANDS_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated shell command lines run in order in a freshly-created isolated worktree before it is handed to an agent (e.g. "bun install, bun run codegen"). A command that exits non-zero stops setup there and marks the worktree failed — visible on /worktree review and the worktree record, never silent. Empty = no setup commands run.',
};

export const WORKTREE_SETUP_CARRY_OVER_GLOBS_SYNTHETIC_SETTING: ConfigSetting = {
  key: WORKTREE_SETUP_CARRY_OVER_GLOBS_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated glob patterns (e.g. ".env, .env.*, config/local.json") of UNTRACKED files copied from the source working tree into a freshly-created isolated worktree, after setup commands run. Only files git reports as untracked are eligible — committed files already carry over through the worktree checkout itself. Empty = nothing carried over.',
};

function buildWorktreeSetupListEntry(configManager: Pick<ConfigManager, 'get'>, setting: ConfigSetting): SettingEntry {
  const currentValue = readWorktreeSetupList(configManager, setting.key);
  return {
    setting,
    currentValue,
    isDefault: currentValue.length === 0,
  };
}

export function buildWorktreeSetupCommandsSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  return buildWorktreeSetupListEntry(configManager, WORKTREE_SETUP_COMMANDS_SYNTHETIC_SETTING);
}

export function buildWorktreeSetupCarryOverGlobsSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  return buildWorktreeSetupListEntry(configManager, WORKTREE_SETUP_CARRY_OVER_GLOBS_SYNTHETIC_SETTING);
}
