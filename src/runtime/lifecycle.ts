/**
 * Lifecycle management for the goodvibes-tui runtime.
 *
 * Handles ordered teardown: persist session, fire lifecycle hooks,
 * stop background managers. Terminal teardown remains in main.ts.
 */
import { getSessionManager } from '../sessions/manager.ts';
import type { SessionMeta } from '../sessions/manager.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import type { HookPhase, HookCategory, HookEventPath } from '../hooks/types.ts';
import { ScheduleManager } from '../tools/workflow/index.ts';
import { providerRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';

// ── Session persistence helpers ──────────────────────────────────────────────

/**
 * Persist conversation messages to the user sessions store.
 * Non-fatal: logs on failure but does not throw.
 */
export function saveSession(
  sessionId: string,
  data: { messages: object[]; timestamp?: number },
  model: string,
  provider: string,
  title = '',
): void {
  try {
    const sm = getSessionManager();
    const meta: SessionMeta = {
      title,
      model,
      provider,
      timestamp: data.timestamp ?? Date.now(),
    };
    sm.save(sessionId, data.messages as Array<Record<string, unknown>>, meta);
  } catch (e) {
    logger.debug('saveSession failed', { error: String(e) });
  }
}

// ── Startup lifecycle ────────────────────────────────────────────────────────

/**
 * Fire the session:start lifecycle hook.
 * Non-fatal: errors are logged and swallowed.
 */
export function fireSessionStart(sessionId: string): void {
  try {
    getHookDispatcher().fire({
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
  sessionData: { messages: object[]; timestamp?: number },
  model: string,
  provider: string,
  title = '',
): Promise<void> {
  // Step 1: persist conversation
  saveSession(sessionId, sessionData, model, provider, title);

  // Step 2: lifecycle hooks (fire-and-forget, best-effort before process exit)
  const hookDispatcher = getHookDispatcher();

  const fireHook = (specific: string): void => {
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
  try { ScheduleManager.getInstance().destroy(); } catch (err) { logger.debug('ScheduleManager.destroy failed (non-fatal)', { error: String(err) }); }

  // Step 4: stop provider registry watcher
  try { providerRegistry.stopWatching(); } catch (err) { logger.debug('providerRegistry.stopWatching failed (non-fatal)', { error: String(err) }); }
}
