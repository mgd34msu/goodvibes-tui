/**
 * recall-files-config.ts — TUI-local synthetic setting for the memory file
 * projection directory (`memory.projection.dir`).
 *
 * `memory.projection.dir` is not in the SDK's ConfigKey union — same
 * situation as worktree.setup.commands (see worktree-setup-config.ts, which
 * this file mirrors): a brand-new top-level config section with no
 * DEFAULT_CONFIG entry, so ConfigManager.get()/set() path resolution can
 * throw for it. Read defensively; the settings-modal write path already
 * degrades a resolution failure into an honest "Save failed" message.
 *
 * Default: `.goodvibes/memory/projection`, relative to the project working
 * directory — under the project's own `.goodvibes/` control directory,
 * alongside the (separate) KV-state memory directory used by the state tool.
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';

export const MEMORY_PROJECTION_DIR_CONFIG_KEY = 'memory.projection.dir' as ConfigKey;

/** Default projection directory, relative to the project working directory. */
export const MEMORY_PROJECTION_DIR_DEFAULT = '.goodvibes/memory/projection';

export const MEMORY_PROJECTION_DIR_SYNTHETIC_SETTING: ConfigSetting = {
  key: MEMORY_PROJECTION_DIR_CONFIG_KEY,
  type: 'string',
  default: MEMORY_PROJECTION_DIR_DEFAULT,
  description: '/recall files sync writes one markdown file per standing (project/team-scope) memory record here, and commits the directory when it sits inside a git repository. Relative paths resolve against the project working directory. /recall files review reads user edits back from this directory as proposals — a file edit or deletion never mutates the store directly.',
};

/** Read the configured projection directory, falling back to the default for an absent/malformed value. */
export function readMemoryProjectionDir(configManager: Pick<ConfigManager, 'get'>): string {
  let raw: unknown;
  try {
    raw = configManager.get(MEMORY_PROJECTION_DIR_CONFIG_KEY);
  } catch {
    return MEMORY_PROJECTION_DIR_DEFAULT;
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : MEMORY_PROJECTION_DIR_DEFAULT;
}

export function isMemoryProjectionDirConfigKey(key: ConfigKey): boolean {
  return key === MEMORY_PROJECTION_DIR_CONFIG_KEY;
}

export function buildMemoryProjectionDirSyntheticEntry(
  configManager: Pick<ConfigManager, 'get'>,
): { setting: ConfigSetting; currentValue: string; isDefault: boolean } {
  const currentValue = readMemoryProjectionDir(configManager);
  return {
    setting: MEMORY_PROJECTION_DIR_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue === MEMORY_PROJECTION_DIR_DEFAULT,
  };
}
