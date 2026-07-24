/**
 * Helper factory for main()'s stdin fast-path: the one-key error-retry
 * affordance. Extracted from main.ts so the entrypoint stays under the
 * architecture line ceiling; main() wires this with its live services.
 *
 * The silent startup auto-restore that used to live here
 * (autoRestoreRecoverySession, plus its createPersistRecoverySnapshot /
 * createReopenRecoveryPanels factories) has been removed: state restores
 * happen ONLY when the user explicitly asks (a CLI flag, a slash command, or
 * a prompt), never automatically at bare launch (owner ruling). A live
 * recovery snapshot is now surfaced, never applied, by the boot resume
 * notice — see announceResumeState in runtime/resume-notice.ts.
 */

export interface ErrorAffordanceDeps {
  /** True when the failover retry context is armed (a retry is actually possible). */
  readonly retryArmed: boolean;
  /** Re-submit the failed turn via the shared failover retry path (no duplicate user messages). */
  readonly retry: () => void;
  readonly openModelPicker: () => void;
  readonly render: () => void;
}

/**
 * Handle one keypress while the error-retry affordance is active.
 * 'r' retries on the current provider when armed; 'm' opens the model
 * picker. Returns true when the key was consumed; any other key returns
 * false so the caller routes it as normal input.
 */
export function handleErrorAffordanceKey(data: string, deps: ErrorAffordanceDeps): boolean {
  if (data === 'r' && deps.retryArmed) {
    deps.retry();
    deps.render();
    return true;
  }
  if (data === 'm') {
    deps.openModelPicker();
    deps.render();
    return true;
  }
  return false;
}
