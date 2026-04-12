/**
 * Lifecycle management for the goodvibes-tui runtime.
 *
 * Handles ordered teardown: persist session, fire lifecycle hooks,
 * stop background managers. Terminal teardown remains in main.ts.
 */
import type { HookDispatcher } from '../hooks/index.ts';
import type { HookPhase, HookCategory, HookEventPath } from '../hooks/types.ts';
import type { ScheduleManager } from '../tools/workflow/index.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';
export { saveSession } from './session-persistence.ts';
import { saveSession, type SessionSnapshot } from './session-persistence.ts';
import type { CrossSessionTaskRegistry } from '../sessions/orchestration/index.ts';

// ── Startup lifecycle ────────────────────────────────────────────────────────

/**
 * Fire the session:start lifecycle hook.
 * Non-fatal: errors are logged and swallowed.
 */
export function fireSessionStart(
  sessionId: string,
  hookDispatcher: Pick<HookDispatcher, 'fire'> | null,
): void {
  if (!hookDispatcher) return;
  try {
    hookDispatcher.fire({
      path: 'Lifecycle:session:start' as HookEventPath,
      phase: 'Lifecycle' as HookPhase,
      category: 'session' as HookCategory,
      specific: 'start',
      sessionId,
      timestamp: Date.now(),
      payload: { sessionId },
    }).catch((err: unknown) => {
      logger.debug('fireSessionStart hook error (non-fatal)', { error: String(err) });
    });
  } catch (err) {
    logger.debug('fireSessionStart sync error (non-fatal)', { error: String(err) });
  }
}

// ── Shutdown lifecycle ───────────────────────────────────────────────────────

/**
 * Ordered logical shutdown of all background runtime subsystems.
 *
 * Sequence:
 * 1. Persist conversation to sessions store
 * 2. Fire session:end and session:save lifecycle hooks
 * 3. Destroy ScheduleManager (cancels pending scheduled tasks)
 * 4. Stop provider registry file-watcher
 *
 * This function does NOT touch the terminal (alt-screen, raw mode, etc.) —
 * that remains the responsibility of main.ts.
 *
 * @param sessionId  - Active session identifier.
 * @param sessionData - Latest conversation to persist.
 * @param model      - Active model identifier.
 * @param provider   - Active provider identifier.
 * @param title      - Conversation title (may be empty string).
 */
export async function shutdownRuntime(
  sessionId: string,
  sessionData: SessionSnapshot,
  model: string,
  provider: string,
  title = '',
  scheduleManager?: ScheduleManager | null,
  hookDispatcher?: Pick<HookDispatcher, 'fire'> | null,
  providerRegistry?: Pick<ProviderRegistry, 'stopWatching'> | null,
  sessionOrchestration?: Pick<CrossSessionTaskRegistry, 'dispose'> | null,
): Promise<void> {
  // Step 1: persist conversation
  saveSession(sessionId, sessionData, model, provider, title);

  // Step 2: lifecycle hooks (fire-and-forget, best-effort before process exit)
  const fireHook = (specific: string): void => {
    if (!hookDispatcher) return;
    try {
      hookDispatcher.fire({
        path: `Lifecycle:session:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'session' as HookCategory,
        specific,
        sessionId,
        timestamp: Date.now(),
        payload: { sessionId },
      }).catch((err: unknown) => { logger.debug('shutdownRuntime hook fire error (non-fatal)', { specific, error: String(err) }); });
    } catch (err) { logger.debug('shutdownRuntime hook sync error (non-fatal)', { specific, error: String(err) }); }
  };

  fireHook('end');
  fireHook('save');

  // Step 3: stop ScheduleManager
  try { scheduleManager?.destroy(); } catch (err) { logger.debug('ScheduleManager.destroy failed (non-fatal)', { error: String(err) }); }

  // Step 4: stop provider registry watcher
  try { providerRegistry?.stopWatching(); } catch (err) { logger.debug('providerRegistry.stopWatching failed (non-fatal)', { error: String(err) }); }

  // Step 5: dispose cross-session orchestration registry if it is app-owned in this runtime
  try { sessionOrchestration?.dispose(); } catch (err) { logger.debug('sessionOrchestration.dispose failed (non-fatal)', { error: String(err) }); }
}
