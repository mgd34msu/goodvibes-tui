/**
 * recovery-autosave.ts — periodic recovery-file autosave + liveness-marker
 * refresh, extracted out of main.ts to keep it under the architecture
 * line-count gate.
 *
 * Two things happen on the same cadence (default 60s):
 *   1. The existing crash-recovery snapshot write (writeRecoveryFile).
 *   2. The liveness marker refresh (see session-liveness-marker.ts) that lets
 *      a second instance tell "this session is open in another terminal
 *      right now" from "this is an orphaned crash snapshot".
 * The marker is also written once immediately (not just on the first tick of
 * the interval) so a second instance checking soon after this one launches
 * sees it promptly rather than waiting up to a minute.
 */
import { buildPersistedSessionContext, writeRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { writeLivenessMarker } from './session-liveness-marker.ts';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.ts';

export interface StartRecoveryAutosaveOptions {
  readonly conversation: ConversationManager;
  readonly runtime: { readonly sessionId: string };
  /**
   * The app's declare-once session-storage handle. Both the snapshot and the
   * liveness marker resolve off it, so the startup recovery offer — which
   * reads through the same handle — looks in the directory this writer used.
   */
  readonly surface: SessionSurface;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContext>[2];
  /** Overridable for tests. Defaults to 60s. */
  readonly intervalMs?: number;
}

export function startRecoveryAutosave(options: StartRecoveryAutosaveOptions): ReturnType<typeof setInterval> {
  const { conversation, runtime, surface, buildSessionContinuityHints, intervalMs = 60_000 } = options;
  writeLivenessMarker(surface, runtime.sessionId);
  return setInterval(() => {
    const snapshot = conversation.toJSON() as { messages: Array<ConversationMessageSnapshot> };
    const persisted = buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints());
    writeRecoveryFile(
      { ...snapshot, ...persisted },
      runtime.sessionId,
      conversation.title ?? '',
      { surface },
    );
    writeLivenessMarker(surface, runtime.sessionId);
  }, intervalMs);
}
