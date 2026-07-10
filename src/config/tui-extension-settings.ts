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
