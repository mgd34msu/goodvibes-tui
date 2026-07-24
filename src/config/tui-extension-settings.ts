/**
 * TUI-extension settings — config namespaces the TUI reads that are NOT part
 * of the SDK's ConfigManager schema.
 *
 * The SDK owns settings.json's typed schema (its `ConfigKey` union), but its
 * loader deep-merges user JSON over the defaults and only strips unknown
 * `permissions.tools` keys — every other unknown top-level key survives load
 * and round-trips through `save()`. That lets the TUI keep its own namespaces
 * (e.g. `checkpoints.*`) in the same settings.json file and read them back
 * here via `getRaw()`.
 *
 * Every reader hand-validates each field and returns a PARTIAL object holding
 * only the keys the user actually set to a well-typed value. A missing or
 * malformed block yields an empty object rather than throwing, so a bad edit
 * degrades to "use the built-in defaults", never a crash. Returning a partial
 * (rather than filling in defaults here) keeps the underlying default values
 * owned by their real consumer instead of being duplicated in the TUI.
 */

import type { ConfigManager } from './index.ts';

type RawRecord = Record<string, unknown>;

function readNamespace(configManager: Pick<ConfigManager, 'getRaw'>, namespace: string): RawRecord | null {
  const block = (configManager.getRaw() as RawRecord)[namespace];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  return block as RawRecord;
}

function readBoolean(src: RawRecord, key: string): boolean | undefined {
  const value = src[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readPositiveInt(src: RawRecord, key: string): number | undefined {
  const value = src[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function readNonEmptyString(src: RawRecord, key: string): string | undefined {
  const value = src[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ─── statusline.* — scriptable status line ───────────────────────────────────

/**
 * User-settable scriptable status line. When `command` is present it is run as
 * a POSIX shell command at each turn boundary and its first stdout line renders
 * in the status area. `timeoutMs` bounds each run.
 */
export interface StatuslineSettings {
  /** Shell command whose first stdout line renders in the status area. Absent/empty disables the feature. */
  readonly command?: string;
  /** Per-run timeout in milliseconds. Defaults to 2000; clamped to [100, 15000]. */
  readonly timeoutMs?: number;
}

export const STATUSLINE_DEFAULT_TIMEOUT_MS = 2000;
const STATUSLINE_MIN_TIMEOUT_MS = 100;
const STATUSLINE_MAX_TIMEOUT_MS = 15_000;

// ─── session.* — session behavior ────────────────────────────────────────────

/** User-settable session behavior. */
export interface SessionSettings {
  /**
   * Auto-title an untitled session using the configured tool/helper (weak/fast)
   * model after the first turn. Off by default because it costs a small model
   * call. Only ever sets a system-sourced title; a user-chosen title is left alone.
   */
  readonly autoTitle?: boolean;
}

/** Read `session.*` from settings.json. */
export function readSessionSettings(configManager: Pick<ConfigManager, 'getRaw'>): SessionSettings {
  const src = readNamespace(configManager, 'session');
  if (!src) return {};
  const out: { autoTitle?: boolean } = {};
  const autoTitle = readBoolean(src, 'autoTitle');
  if (autoTitle !== undefined) out.autoTitle = autoTitle;
  return out;
}

/** Read `statusline.*` from settings.json, validating and clamping the timeout. */
export function readStatuslineSettings(configManager: Pick<ConfigManager, 'getRaw'>): StatuslineSettings {
  const src = readNamespace(configManager, 'statusline');
  if (!src) return {};
  const out: { command?: string; timeoutMs?: number } = {};
  const command = readNonEmptyString(src, 'command');
  if (command !== undefined) out.command = command;
  const timeoutMs = readPositiveInt(src, 'timeoutMs');
  if (timeoutMs !== undefined) {
    out.timeoutMs = Math.min(STATUSLINE_MAX_TIMEOUT_MS, Math.max(STATUSLINE_MIN_TIMEOUT_MS, timeoutMs));
  }
  return out;
}

// ─── update.* — launch-time self-update behavior ─────────────────────────────

/**
 * User-settable launch-time self-update behavior. The feature itself (check at
 * launch, install via the checksum-verified download/verify/swap path, restart
 * onto the new binary) defaults ON for binary installs; the defaults live in
 * the consumer (src/cli/launch-auto-update.ts), matching this file's rule that
 * readers return only what the user actually set.
 */
export interface UpdateSettings {
  /** Check for a newer release at TUI launch and install it before starting. Default: true. */
  readonly autoUpdateAtLaunch?: boolean;
  /** How long the launch-time version check may take before it is skipped. Defaults to 2500; clamped to [250, 30000]. */
  readonly launchCheckTimeoutMs?: number;
  /** How long the launch-time download+verify+swap may take before it is deferred to the next launch. Defaults to 45000; clamped to [5000, 300000]. */
  readonly applyTimeoutMs?: number;
}

const LAUNCH_CHECK_MIN_TIMEOUT_MS = 250;
const LAUNCH_CHECK_MAX_TIMEOUT_MS = 30_000;
const LAUNCH_APPLY_MIN_TIMEOUT_MS = 5_000;
const LAUNCH_APPLY_MAX_TIMEOUT_MS = 300_000;

/** Read `update.*` from settings.json, validating and clamping the timeout. */
export function readUpdateSettings(configManager: Pick<ConfigManager, 'getRaw'>): UpdateSettings {
  const src = readNamespace(configManager, 'update');
  if (!src) return {};
  const out: { autoUpdateAtLaunch?: boolean; launchCheckTimeoutMs?: number; applyTimeoutMs?: number } = {};
  const autoUpdateAtLaunch = readBoolean(src, 'autoUpdateAtLaunch');
  if (autoUpdateAtLaunch !== undefined) out.autoUpdateAtLaunch = autoUpdateAtLaunch;
  const launchCheckTimeoutMs = readPositiveInt(src, 'launchCheckTimeoutMs');
  if (launchCheckTimeoutMs !== undefined) {
    out.launchCheckTimeoutMs = Math.min(LAUNCH_CHECK_MAX_TIMEOUT_MS, Math.max(LAUNCH_CHECK_MIN_TIMEOUT_MS, launchCheckTimeoutMs));
  }
  const applyTimeoutMs = readPositiveInt(src, 'applyTimeoutMs');
  if (applyTimeoutMs !== undefined) {
    out.applyTimeoutMs = Math.min(LAUNCH_APPLY_MAX_TIMEOUT_MS, Math.max(LAUNCH_APPLY_MIN_TIMEOUT_MS, applyTimeoutMs));
  }
  return out;
}

// ─── checkpoints.* — workspace checkpoint root-guard options ─────────────────

/**
 * User-settable root-guard options for the SDK's WorkspaceCheckpointManager.
 * All optional: an omitted key defers to the manager's own default. Field
 * names and semantics mirror the SDK's `WorkspaceCheckpointManagerOptions`.
 */
export interface CheckpointGuardSettings {
  /** Prefer the enclosing git repo's top level over the raw workspace root. SDK default: true. */
  readonly preferGitRoot?: boolean;
  /** Opt in to snapshotting a broad root (filesystem root / home / ~/.goodvibes). SDK default: false. */
  readonly allowBroadRoot?: boolean;
  /** Opt in to a first snapshot whose full sweep exceeds maxFirstSnapshotFiles. SDK default: false. */
  readonly allowLargeFirstSnapshot?: boolean;
  /** Ceiling for the first-ever snapshot's file sweep. SDK default: 50000. */
  readonly maxFirstSnapshotFiles?: number;
  /** Run a retention sweep automatically after each create() and once at init. SDK default: true. */
  readonly autoRetention?: boolean;
}

/**
 * Merge the user's `checkpoints.*` root-guard settings onto a base
 * WorkspaceCheckpointManager options object.
 *
 * NOTE: the pinned platform SDK's WorkspaceCheckpointManager may predate these
 * root-guard options — an older constructor reads only
 * workspaceRoot/checkpointDir/runtimeBus/retention/now and silently ignores the
 * rest, making the guard keys INERT. They become effective the moment the SDK
 * is upgraded to a build whose options type declares them (preferGitRoot,
 * allowBroadRoot, allowLargeFirstSnapshot, maxFirstSnapshotFiles,
 * autoRetention) — no code change needed here. The return type intersects the
 * base with CheckpointGuardSettings so the extra keys flow through structurally
 * without an unsafe cast.
 */
export function withCheckpointGuardSettings<T extends object>(
  base: T,
  configManager: Pick<ConfigManager, 'getRaw'>,
): T & CheckpointGuardSettings {
  return { ...base, ...readCheckpointGuardSettings(configManager) };
}

/**
 * Read `checkpoints.*` from settings.json. Returns only the keys present and
 * well-typed; unknown or malformed values are dropped so the SDK's own
 * defaults apply for them.
 */
export function readCheckpointGuardSettings(configManager: Pick<ConfigManager, 'getRaw'>): CheckpointGuardSettings {
  const src = readNamespace(configManager, 'checkpoints');
  if (!src) return {};
  const out: {
    preferGitRoot?: boolean;
    allowBroadRoot?: boolean;
    allowLargeFirstSnapshot?: boolean;
    maxFirstSnapshotFiles?: number;
    autoRetention?: boolean;
  } = {};
  const preferGitRoot = readBoolean(src, 'preferGitRoot');
  if (preferGitRoot !== undefined) out.preferGitRoot = preferGitRoot;
  const allowBroadRoot = readBoolean(src, 'allowBroadRoot');
  if (allowBroadRoot !== undefined) out.allowBroadRoot = allowBroadRoot;
  const allowLargeFirstSnapshot = readBoolean(src, 'allowLargeFirstSnapshot');
  if (allowLargeFirstSnapshot !== undefined) out.allowLargeFirstSnapshot = allowLargeFirstSnapshot;
  const maxFirstSnapshotFiles = readPositiveInt(src, 'maxFirstSnapshotFiles');
  if (maxFirstSnapshotFiles !== undefined) out.maxFirstSnapshotFiles = maxFirstSnapshotFiles;
  const autoRetention = readBoolean(src, 'autoRetention');
  if (autoRetention !== undefined) out.autoRetention = autoRetention;
  return out;
}
