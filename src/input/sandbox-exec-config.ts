/**
 * sandbox-exec-config.ts — TUI-local synthetic settings entries for
 * sandbox.egressAllowlist / sandbox.workspaceWritable.
 *
 * The SDK's per-command exec sandbox (bubblewrap on Linux, gated by the
 * graduation-tracked `exec-sandbox` feature flag) reads its full configuration
 * straight off `configManager.getCategory('sandbox')` inside
 * `registerAllTools` (platform/tools/index.ts) — `sandbox.enabled`,
 * `sandbox.egressAllowlist`, `sandbox.workspaceWritable`. `sandbox.enabled` is
 * already a real CONFIG_SCHEMA key (with its own honest "requires bubblewrap
 * on Linux, reports unavailable elsewhere" description) and needs no synthetic
 * entry — the CONFIG_SCHEMA loop in settings-modal-data.ts already surfaces it.
 * `egressAllowlist`/`workspaceWritable` are NOT in CONFIG_SCHEMA, so this file
 * mirrors worktree-setup-config.ts's synthetic-entry pattern for them.
 *
 * UNLIKE worktree.setup.* / learning.consolidation.*, no defensive try/catch is
 * needed here: DEFAULT_CONFIG.sandbox already carries both fields (as empty
 * arrays), so ConfigManager.resolvePath finds the `sandbox` section on a plain
 * get()/set() without throwing — only a missing SECTION throws, and `sandbox`
 * has existed since before this repack (it backs the older VM/REPL isolation
 * settings). Writing through these entries takes effect for real: the exec
 * sandbox reads the same `sandbox` config category at tool-registration time.
 *
 * Both keys hold a JSON array of strings on disk. The settings modal's inline
 * editor is a single-line text field, so — matching worktree.setup.* and
 * controlPlane.cors.allowedOrigins — they are displayed and edited as a
 * comma-separated list and parsed back into an array on commit (see
 * isSandboxExecListConfigKey's use in settings-modal.ts#commitEdit).
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@pellux/goodvibes-sdk/platform/config';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

export const SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY = 'sandbox.egressAllowlist' as ConfigKey;
export const SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY = 'sandbox.workspaceWritable' as ConfigKey;

const SANDBOX_EXEC_LIST_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set([
  SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY,
  SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
]);

/** True for the two sandbox exec-boundary list keys, whose stored value is a string array edited as a comma-separated list. */
export function isSandboxExecListConfigKey(key: ConfigKey): boolean {
  return SANDBOX_EXEC_LIST_CONFIG_KEYS.has(key);
}

/** Read a config value as a string array (non-array/malformed degrades to empty). */
export function readSandboxExecList(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string[] {
  const raw = configManager.get(key);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** Parse a comma-separated edit-buffer submission back into a string array (trimmed, empties dropped). Shared with worktree.setup.* — same convention. */
export function parseSandboxExecListInput(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export const SANDBOX_EGRESS_ALLOWLIST_SYNTHETIC_SETTING: ConfigSetting = {
  key: SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated command base names (or "*" for all) whose network access is re-enabled inside the per-command exec sandbox boundary, as a named escalation the approval flow surfaces ("wants network"). Empty = the sandbox disables network for every command. Only takes effect when sandbox.enabled is on, the exec-sandbox setting is on, and bubblewrap is available (Linux only — reports unavailable elsewhere).',
};

export const SANDBOX_WORKSPACE_WRITABLE_SYNTHETIC_SETTING: ConfigSetting = {
  key: SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated absolute paths outside the workspace bound writable into the per-command exec sandbox boundary, as a named escalation the approval flow surfaces ("wants path outside workspace"). Empty = only the workspace (and an isolated /tmp) is writable. Only takes effect when sandbox.enabled is on, the exec-sandbox setting is on, and bubblewrap is available (Linux only — reports unavailable elsewhere).',
};

function buildSandboxExecListEntry(configManager: Pick<ConfigManager, 'get'>, setting: ConfigSetting): SettingEntry {
  const currentValue = readSandboxExecList(configManager, setting.key);
  return {
    setting,
    currentValue,
    isDefault: currentValue.length === 0,
  };
}

export function buildSandboxEgressAllowlistSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  return buildSandboxExecListEntry(configManager, SANDBOX_EGRESS_ALLOWLIST_SYNTHETIC_SETTING);
}

export function buildSandboxWorkspaceWritableSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  return buildSandboxExecListEntry(configManager, SANDBOX_WORKSPACE_WRITABLE_SYNTHETIC_SETTING);
}

/**
 * Inject both synthetic entries into the sandbox category's SettingEntry list
 * (alongside the real sandbox.enabled CONFIG_SCHEMA entry the caller's own
 * CONFIG_SCHEMA loop already added), idempotently. No-op when the category
 * isn't present in `groups` at all.
 */
export function injectSandboxExecSyntheticEntries(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: Pick<ConfigManager, 'get'>,
): void {
  const sandboxEntries = groups.get('sandbox');
  if (!sandboxEntries) return;
  if (!sandboxEntries.some((e) => e.setting.key === SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY)) {
    sandboxEntries.push(buildSandboxEgressAllowlistSyntheticEntry(configManager));
  }
  if (!sandboxEntries.some((e) => e.setting.key === SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY)) {
    sandboxEntries.push(buildSandboxWorkspaceWritableSyntheticEntry(configManager));
  }
}
