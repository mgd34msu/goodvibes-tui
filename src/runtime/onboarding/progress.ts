import { existsSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '@pellux/goodvibes-sdk/platform/config';
import { readVersioned } from '@pellux/goodvibes-sdk/platform/config';

import type {
  OnboardingMode,
  OnboardingShellPaths,
  WizardProgressPayload,
  WizardProgressState,
} from './types.ts';

const WIZARD_PROGRESS_FILE = 'onboarding-progress.json';

function resolveProgressPath(shellPaths: OnboardingShellPaths): string {
  return shellPaths.resolveUserPath('tui', WIZARD_PROGRESS_FILE);
}

function isWizardProgressPayload(value: unknown): value is WizardProgressPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v['version'] !== 1) return false;
  if (typeof v['savedAt'] !== 'number' || !Number.isFinite(v['savedAt'] as number)) return false;
  const mode = v['mode'];
  if (mode !== 'new' && mode !== 'edit' && mode !== 'reopen') return false;
  if (typeof v['stepIndex'] !== 'number' || !Number.isFinite(v['stepIndex'] as number)) return false;
  if (!Array.isArray(v['toggleState'])) return false;
  if (!Array.isArray(v['radioState'])) return false;
  if (!Array.isArray(v['textState'])) return false;
  return true;
}

/**
 * Path to the wizard progress file (user-scoped, in ~/.config/goodvibes/tui/).
 */
export function getWizardProgressPath(shellPaths: OnboardingShellPaths): string {
  return resolveProgressPath(shellPaths);
}

/**
 * Read the persisted wizard progress, if any.
 *
 * Returns a WizardProgressState with exists=false when no progress file is
 * present. Returns exists=true, payload=null with a parseError when the file
 * is present but unreadable or schema-mismatched (the bad file is left in
 * place so the caller can decide whether to delete it).
 */
export function readWizardProgress(shellPaths: OnboardingShellPaths): WizardProgressState {
  const path = resolveProgressPath(shellPaths);

  const parsed = readVersioned<WizardProgressPayload & { version: number }>(
    path,
    { currentVersion: 1, onUnknown: 'quarantine' },
  );

  if (parsed === null) {
    const nowExists = existsSync(path);
    const quarantined = existsSync(`${path}.unrecognized`);
    if (!nowExists && !quarantined) return { path, exists: false, payload: null };
    return {
      path,
      exists: true,
      payload: null,
      parseError: quarantined
        ? 'Unrecognised or corrupt wizard progress file; quarantined.'
        : 'Invalid wizard progress payload.',
    };
  }

  if (!isWizardProgressPayload(parsed)) {
    return { path, exists: true, payload: null, parseError: 'Invalid wizard progress payload.' };
  }

  return { path, exists: true, payload: parsed };
}

export interface WriteWizardProgressOptions {
  readonly mode: OnboardingMode;
  readonly stepIndex: number;
  readonly toggleState: ReadonlyArray<readonly [string, boolean]>;
  readonly radioState: ReadonlyArray<readonly [string, string]>;
  readonly textState: ReadonlyArray<readonly [string, string]>;
  readonly clock?: () => number;
}

/**
 * Atomically persist wizard progress to disk.
 *
 * Uses atomicWriteFileSync (write-to-tmp + rename) so a crash mid-write
 * never leaves a torn file. The file is user-scoped so it survives across
 * project switches and is shared with the resume-prompt check at startup.
 *
 * Masked (password) fields are deliberately excluded from the serialised
 * textState by the caller — this function accepts whatever is passed in and
 * does NOT filter. Callers must strip sensitive fields before calling.
 */
export function writeWizardProgress(
  shellPaths: OnboardingShellPaths,
  options: WriteWizardProgressOptions,
): void {
  const path = resolveProgressPath(shellPaths);
  const payload: WizardProgressPayload = {
    version: 1,
    savedAt: (options.clock ?? Date.now)(),
    mode: options.mode,
    stepIndex: options.stepIndex,
    toggleState: options.toggleState,
    radioState: options.radioState,
    textState: options.textState,
  };
  atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
}

/**
 * Delete the wizard progress file (best-effort; ignores ENOENT).
 *
 * Called after a successful apply so the resume prompt is not shown on
 * next startup.
 */
export function deleteWizardProgress(shellPaths: OnboardingShellPaths): void {
  const path = resolveProgressPath(shellPaths);
  try { unlinkSync(path); } catch { /* best-effort: file may not exist */ }
}

/**
 * Returns true when an in-progress wizard session was interrupted and is
 * still recent enough to reopen on startup (the caller reopens the wizard
 * at the saved step so the user can continue or dismiss it).
 *
 * A progress file is considered resumable when:
 *   - it exists and can be parsed (payload !== null)
 *   - it is less than PROGRESS_MAX_AGE_MS old (default: 7 days)
 *
 * Negative age (future-dated `savedAt`) is treated as non-resumable: it
 * indicates clock skew or a tampered file and is safer to reject than to
 * open a wizard with unknown-age state.
 */
const PROGRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function hasResumableWizardProgress(
  shellPaths: OnboardingShellPaths,
  options: { now?: number; state?: WizardProgressState } = {},
): boolean {
  const state = options.state ?? readWizardProgress(shellPaths);
  if (!state.payload) return false;
  const age = (options.now ?? Date.now()) - state.payload.savedAt;
  // age < 0 means savedAt is in the future (clock skew / tampered file) — treat as non-resumable.
  return age >= 0 && age < PROGRESS_MAX_AGE_MS;
}
