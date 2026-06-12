/**
 * Helper factories for main()'s stdin fast-path: the Ctrl+R recovery
 * persistence/panel-reopen callbacks and the one-key error-retry
 * affordance. Extracted from main.ts so the entrypoint stays under the
 * architecture line ceiling; main() wires these with its live services.
 */

import type { ConversationMessageSnapshot } from '../core/conversation.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';

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
