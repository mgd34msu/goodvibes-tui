import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '@pellux/goodvibes-sdk/platform/config';
import { readVersioned } from '@pellux/goodvibes-sdk/platform/config';

import type {
  OnboardingAcknowledgementRuntimeState,
  OnboardingAcknowledgementTarget,
  OnboardingMode,
  OnboardingShellPaths,
  OnboardingStateScope,
} from './types.ts';

const ONBOARDING_RUNTIME_STATE_FILE = 'onboarding-state.json';

/**
 * Lockfile serialisation for writeOnboardingAcknowledgementState.
 *
 * Mechanism: O_EXCL advisory lockfile in the same directory as the state file.
 * This is the simplest correct approach for two same-host processes (daemon
 * + TUI) that both run this read-modify-write path:
 *
 *   - Acquire: open(<statefile>.lock, O_CREAT|O_EXCL|O_WRONLY), atomic on POSIX.
 *   - Stale detection: if the lockfile mtime is >= LOCK_STALE_MS old, force-remove.
 *   - Retry: up to LOCK_MAX_RETRIES rapid non-blocking attempts (no sleep, main-thread safe).
 *   - Release: unlink the lockfile (best-effort on failure).
 *
 * O_EXCL was chosen over flock(2) because it works on all POSIX targets
 * without requiring an open fd on the guarded file, and is Bun-compatible.
 */
const LOCK_MAX_RETRIES = 10;
const LOCK_STALE_MS = 5_000;

export interface OnboardingRuntimeStateRecord {
  readonly scope: OnboardingStateScope;
  readonly path: string;
  readonly exists: boolean;
  readonly payload: OnboardingAcknowledgementRuntimeState | null;
  readonly parseError?: string;
}

interface WriteOnboardingAcknowledgementStateOptions {
  readonly scope?: OnboardingStateScope;
  readonly target: OnboardingAcknowledgementTarget;
  readonly acknowledged: boolean;
  readonly updatedAt?: number;
  readonly source: string;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
}

function resolveStatePath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope,
): string {
  return scope === 'project'
    ? shellPaths.resolveProjectPath('tui', ONBOARDING_RUNTIME_STATE_FILE)
    : shellPaths.resolveUserPath('tui', ONBOARDING_RUNTIME_STATE_FILE);
}

function isAcknowledgementTarget(value: string): value is OnboardingAcknowledgementTarget {
  return value === 'providers' || value === 'subscriptions' || value === 'auth';
}

function isRuntimeStatePayload(value: unknown): value is OnboardingAcknowledgementRuntimeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) return false;
  if (typeof v['updatedAt'] !== 'number' || !Number.isFinite(v['updatedAt'] as number)) return false;
  if (typeof v['source'] !== 'string') return false;
  const mode = v['mode'];
  if (mode !== undefined && mode !== 'new' && mode !== 'edit' && mode !== 'reopen') return false;
  if (v['workspaceRoot'] !== undefined && typeof v['workspaceRoot'] !== 'string') return false;
  if (typeof v['acknowledgements'] !== 'object' || v['acknowledgements'] === null) return false;

  return Object.entries(v['acknowledgements'] as Record<string, unknown>).every(
    ([key, entry]) => isAcknowledgementTarget(key) && typeof entry === 'boolean',
  );
}

// ─── Lock helpers ──────────────────────────────────────────────────────────────────

function stateLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

/**
 * Attempt to acquire an O_EXCL advisory lock. Returns true if acquired.
 * Stale locks (older than LOCK_STALE_MS) are forcibly removed before retry.
 *
 * Retries are non-blocking (no sleep between attempts) so this function is
 * safe to call on the main thread. Each O_EXCL open is a single syscall;
 * 10 rapid retries add negligible latency and are safe for a one-shot path.
 */
function acquireLock(lp: string): boolean {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    // Stale-lock takeover: if the lockfile is old enough, forcibly remove it.
    try {
      const st = statSync(lp);
      if (Date.now() - st.mtimeMs >= LOCK_STALE_MS) {
        try { unlinkSync(lp); } catch { /* another process may have beaten us */ }
      }
    } catch { /* lockfile does not exist — expected happy path */ }

    try {
      // 'wx' ≡ O_CREAT | O_EXCL | O_WRONLY, fails atomically if file exists.
      const fd = openSync(lp, 'wx');
      closeSync(fd);
      return true;
    } catch { /* file exists, held by another process */ }
  }
  return false;
}

/** Release the advisory lockfile (best-effort). */
function releaseLock(lp: string): void {
  try { unlinkSync(lp); } catch { /* best-effort */ }
}

// ─── Public API ────────────────────────────────────────────────────────────────────

export function getOnboardingRuntimeStatePath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'project',
): string {
  return resolveStatePath(shellPaths, scope);
}

export function readOnboardingRuntimeState(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'project',
): OnboardingRuntimeStateRecord {
  const path = resolveStatePath(shellPaths, scope);

  const parsed = readVersioned<OnboardingAcknowledgementRuntimeState & { version: number }>(
    path,
    { currentVersion: 1, onUnknown: 'quarantine' },
  );

  if (parsed === null) {
    // readVersioned returns null for: missing file, corrupt JSON, or
    // unrecognised version (in which case it renames to <path>.unrecognized).
    const nowExists = existsSync(path);
    const quarantined = existsSync(`${path}.unrecognized`);
    return {
      scope,
      path,
      exists: nowExists || quarantined,
      payload: null,
      ...(quarantined
        ? { parseError: 'Unrecognised or corrupt onboarding state file; quarantined.' }
        : {}),
    };
  }

  if (!isRuntimeStatePayload(parsed)) {
    return {
      scope,
      path,
      exists: true,
      payload: null,
      parseError: 'Invalid onboarding runtime state payload.',
    };
  }

  return { scope, path, exists: true, payload: parsed };
}

export function writeOnboardingAcknowledgementState(
  shellPaths: OnboardingShellPaths,
  options: WriteOnboardingAcknowledgementStateOptions,
): OnboardingRuntimeStateRecord {
  const scope = options.scope ?? 'project';
  const path = resolveStatePath(shellPaths, scope);
  const lp = stateLockPath(path);

  // Ensure the parent directory exists before we try to create the lockfile.
  mkdirSync(dirname(path), { recursive: true });

  const acquired = acquireLock(lp);
  if (!acquired) {
    // Lock exhaustion: another process has held the lock for all LOCK_MAX_RETRIES
    // attempts. Proceeding without the lock, the atomic write (rename) prevents
    // torn files, but under true concurrent contention a concurrent read-modify-write
    // may result in a lost-update (last writer wins). Surfaced here so it is
    // detectable in logs rather than silently discarded.
    console.warn(
      '[goodvibes] onboarding-state: lock exhausted, proceeding without lock.',
      { path, target: options.target, source: options.source },
    );
  }

  try {
    // Re-read (inside the lock when acquired; best-effort when degraded) to get
    // the freshest acknowledgements state, eliminating the read-modify-write
    // race between daemon and TUI under normal conditions.
    const existing = readOnboardingRuntimeState(shellPaths, scope);
    const updatedAt = options.updatedAt ?? Date.now();
    const ws = options.workspaceRoot ?? shellPaths.workingDirectory;
    const payload: OnboardingAcknowledgementRuntimeState = {
      version: 1,
      updatedAt,
      source: options.source,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(ws ? { workspaceRoot: ws } : {}),
      acknowledgements: {
        ...(existing.payload?.acknowledgements ?? {}),
        [options.target]: options.acknowledged,
      },
    };

    atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
  } finally {
    if (acquired) releaseLock(lp);
  }

  return readOnboardingRuntimeState(shellPaths, scope);
}
