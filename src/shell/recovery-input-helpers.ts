/**
 * Helper factories for main()'s stdin fast-path and startup: the crash-recovery
 * snapshot persistence + panel-reopen callbacks, the SILENT auto-restore, and
 * the one-key error-retry affordance. Extracted from main.ts so the entrypoint
 * stays under the architecture line ceiling; main() wires these with its live
 * services.
 *
 * Recovery is silent (owner ruling): there is no Ctrl+R prompt/banner and no
 * dismiss/preserve dance. At startup autoRestoreRecoverySession restores the
 * newest crash snapshot in place and emits a single one-line receipt. The old
 * `.preserved` sibling machinery is gone — a session's exit deletes only its
 * OWN snapshot (scoped by sessionId), so a concurrent session's snapshot is
 * never touched.
 */

import type { ConversationMessageSnapshot } from '../core/conversation.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';
import { autoRestoreRecovery } from '@/runtime/index.ts';
import { replayJournalForSession } from '../core/session-recovery.ts';

export interface PersistRecoveryDeps {
  readonly sessionManager: {
    save(id: string, msgs: never[], meta: { title: string; model: string; provider: string; timestamp: number }): unknown;
  };
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly conversation: { readonly title?: string | null };
}

/** Persist a replayed/restored snapshot through the session manager. */
export function createPersistRecoverySnapshot(deps: PersistRecoveryDeps): (msgs: ConversationMessageSnapshot[]) => void {
  return (msgs) => void deps.sessionManager.save(deps.runtime.sessionId, msgs as never[], {
    title: deps.conversation.title ?? '',
    model: deps.runtime.model,
    provider: deps.runtime.provider,
    timestamp: Date.now(),
  });
}

export interface ReopenPanelsDeps {
  readonly panelManager: { open(id: string): void; show(): void };
  readonly render: () => void;
}

/** Reopen the panels recorded in a restored session's return context (capped at 4). */
export function createReopenRecoveryPanels(deps: ReopenPanelsDeps): (snapshot: SessionSnapshot) => void {
  return (snapshot) => {
    for (const panelId of (snapshot.returnContext?.openPanels ?? []).slice(0, 4)) {
      try { deps.panelManager.open(panelId); } catch { /* unknown panel id */ }
    }
    if ((snapshot.returnContext?.openPanels?.length ?? 0) > 0) { deps.panelManager.show(); deps.render(); }
  };
}

export interface AutoRestoreRecoveryDeps {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** The live conversation to restore INTO (fromJSON applies the snapshot). */
  readonly conversation: {
    fromJSON(input: { messages: ConversationMessageSnapshot[]; title?: string; titleSource?: SessionSnapshot['titleSource'] }): void;
  };
  /** Persist the post-replay snapshot so the WAL gap is durably closed. */
  readonly persistSnapshot: (msgs: ConversationMessageSnapshot[]) => void;
  /** Reopen the restored session's panels. */
  readonly reopenPanels: (snapshot: SessionSnapshot) => void;
  /** Surface the one-line receipt (the only user-visible sign of a restore). */
  readonly systemMessageRouter: { high(message: string): void };
}

/**
 * Silent crash-recovery restore at startup — no prompt, no banner. Loads the
 * newest crash snapshot (the SDK scopes the load AND the follow-up delete to
 * that snapshot's own session id), applies it to the live conversation, replays
 * any journal turns written after the snapshot, reopens its panels, and emits
 * the SDK's one-line receipt. Returns true when a session was restored, false
 * when there was nothing to restore.
 */
export function autoRestoreRecoverySession(deps: AutoRestoreRecoveryDeps): boolean {
  const result = autoRestoreRecovery({ workingDirectory: deps.workingDirectory, homeDirectory: deps.homeDirectory });
  if (!result) return false;
  const { snapshot, info, receipt } = result;
  deps.conversation.fromJSON({
    messages: snapshot.messages as ConversationMessageSnapshot[],
    title: snapshot.title,
    titleSource: snapshot.titleSource,
  });
  // Replay journal records that post-date the snapshot so turns written after
  // the last recovery-file write (but before the crash) are not dropped.
  replayJournalForSession({
    homeDirectory: deps.homeDirectory,
    sessionId: info.sessionId,
    snapshotTimestamp: info.timestamp ?? 0,
    conversation: deps.conversation as never,
    persistSnapshot: deps.persistSnapshot,
  });
  deps.reopenPanels(snapshot);
  deps.systemMessageRouter.high(`[Recovery] ${receipt}`);
  return true;
}

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
