/**
 * settings-modal-mutations, pure mutation helpers for SettingsModal.
 *
 * These functions encapsulate the side-effectful write operations. Every
 * write, feature-unit headers included, is a plain domain-settings config
 * write; the SDK's settings bridge keeps the runtime gate manager in sync
 * (flipping runtime-toggleable gates live and recording honest
 * pending-restart markers for startup-gated ones). Each function takes its
 * dependencies as explicit arguments rather than accessing class-level state.
 */

import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagEntry, SettingEntry } from './settings-modal-types.ts';
import { deepEqual } from './settings-modal-data.ts';

// ---------------------------------------------------------------------------
// ApplyValueResult, returned by applySettingValue so the caller can react
// ---------------------------------------------------------------------------

export interface ApplyValueResult {
  /** Restart domain that was triggered, if any. */
  readonly restartDomain: 'control-plane' | 'http-listener' | 'web' | null;
  /** Message from onSettingApplied handler, if any. */
  readonly effectMessage: string | null;
  /** Whether the value actually changed (false = no-op). */
  readonly changed: boolean;
}

export type SettingAppliedCallback = (change: {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}) => { readonly message?: string } | void;

// ---------------------------------------------------------------------------
// applySettingValue
// ---------------------------------------------------------------------------

/**
 * Where a DAEMON-owned setting is written.
 *
 * `surfaces.*`, `controlPlane.*`, `watchers.*`, `device.*`, `automation.*` and
 * the rest are executed by the daemon, unattended, with every surface closed.
 * Writing one into this surface's own settings file reports success and
 * configures nothing, the daemon reads a different file and never sees it.
 * So a daemon-owned write goes over `config.set`, and a write with no reachable
 * daemon FAILS rather than landing somewhere harmless-looking.
 */
export interface DaemonOwnedConfigWriter {
  ownsKey(key: string): boolean;
  set(key: string, value: unknown): Promise<void>;
}

export function applySettingValue({
  key,
  value,
  configManager,
  groups,
  onSettingApplied,
  refreshGroups,
  daemonConfig,
  onAsyncError,
}: {
  key: ConfigKey;
  value: unknown;
  configManager: ConfigManager;
  groups: Map<string, SettingEntry[]>;
  onSettingApplied: SettingAppliedCallback | null;
  /** Called after applying the value so the caller can re-read currentValues. */
  refreshGroups: () => void;
  /** Present when a daemon is configured; absent keeps every write local. */
  daemonConfig?: DaemonOwnedConfigWriter | null | undefined;
  /** Renders a refused daemon write, so a failed save is never silent. */
  onAsyncError?: ((message: string) => void) | undefined;
}): ApplyValueResult {
  // Defensive: a handful of TUI-local synthetic keys (see worktree-setup-config.ts)
  // live under a config section CONFIG_SCHEMA/DEFAULT_CONFIG has never populated
  // (e.g. 'worktree' as of the SDK 1.6.1 repack), so configManager.get can throw
  // "Invalid config path" here even though the write attempt below is already
  // guarded. Without this, that read, which runs unconditionally, before the
  // write's own try/catch, would crash the whole settings modal on save instead
  // of surfacing the honest "Save failed" message the write path below produces.
  let previousValue: unknown;
  try {
    previousValue = configManager.get(key);
  } catch (e) {
    logger.error('SettingsModal: failed to read previous config value', { key, error: summarizeError(e) });
  }
  // REQUIRES_RESTART: SDK's ConfigSetting has no requiresRestart field yet (see
  // goodvibes-sdk HANDOFF-FROM-TUI-SESSION-20260611.md §Item 8). Until it does,
  // we detect restart-triggering keys by sub-key name heuristic below.
  const isRestartKey = ['host', 'port', 'hostMode', 'enabled'].includes(key.split('.')[1] ?? '');

  const daemonOwned = daemonConfig?.ownsKey(key) === true;
  try {
    if (daemonOwned && daemonConfig) {
      // The daemon's store is the one that counts for this key. The local
      // manager is still written so this session's own reads and the rows
      // below reflect the edit immediately; the daemon's copy is what the
      // daemon acts on, and a refusal from it is surfaced rather than
      // swallowed, the local value would then be the lie.
      void daemonConfig.set(key, value).catch((error) => {
        logger.error('SettingsModal: the daemon refused a daemon-owned config write', { key, error: summarizeError(error) });
        onAsyncError?.(`That setting is applied by the daemon and saving it there failed: ${summarizeError(error)}`);
      });
    }
    configManager.setDynamic(key, value);
  } catch (e) {
    logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
    return {
      restartDomain: null,
      effectMessage: `Save failed: ${summarizeError(e)}`,
      changed: false,
    };
  }

  // Update every entry carrying this key: cross-listed rows (the network
  // combined view) and feature-unit headers that share one enablement key
  // (e.g. both compaction features read behavior.compactionStrategy).
  for (const entries of groups.values()) {
    for (const entry of entries) {
      if (entry.setting.key !== key) continue;
      entry.currentValue = configManager.get(key);
      entry.isDefault = deepEqual(entry.currentValue, entry.setting.default);
    }
  }

  // Determine restart domain
  let restartDomain: 'control-plane' | 'http-listener' | 'web' | null = null;
  if (previousValue !== value && isRestartKey) {
    const rawCat = key.split('.')[0] as string;
    if (rawCat === 'controlPlane') restartDomain = 'control-plane';
    else if (rawCat === 'httpListener') restartDomain = 'http-listener';
    else if (rawCat === 'web') restartDomain = 'web';
  }

  // Fire change callback
  let effectMessage: string | null = null;
  if (previousValue !== value && onSettingApplied) {
    const result = onSettingApplied({ key, previousValue, value });
    effectMessage = result?.message ?? null;
    refreshGroups();
  }

  return { restartDomain, effectMessage, changed: previousValue !== value };
}

/**
 * Refresh a FlagEntry's live/persisted/pending fields from the manager's
 * authoritative snapshot so the settings UI never displays a guessed state.
 */
export function syncFlagEntryFromManager(
  flagEntry: FlagEntry,
  featureFlagManager: FeatureFlagManager,
): void {
  const snapshot = featureFlagManager.getAll().get(flagEntry.flag.id);
  if (!snapshot) return;
  flagEntry.state = snapshot.state;
  flagEntry.persistedState = snapshot.persistedState;
  flagEntry.pendingRestart = snapshot.pendingRestart;
}
