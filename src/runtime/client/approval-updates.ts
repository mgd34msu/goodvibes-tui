/**
 * approval-updates.ts, this terminal's subscription to approval decisions made
 * somewhere else.
 *
 * ── What this replaces ────────────────────────────────────────────────────
 *
 * The SDK's client raiser (approval-raiser.ts) raises an ask on the daemon and
 * prompts locally at the same time, and then has to learn about a decision made
 * on another surface, a phone, the web UI, a second terminal. Without a push
 * channel wired it learns by RE-READING the record on an interval, which is
 * both slower than it needs to be and the thing the `control.approval_update`
 * event exists to end. Wiring this seam makes a remote decision arrive in the
 * time one frame takes.
 *
 * The interval is deliberately KEPT as the fallback, not removed: a terminal
 * whose daemon refuses the stream (no daemon, a 401, a proxy that will not hold
 * a connection) still has to be able to answer a tool call. `watchApprovalUpdates`
 * reports failure by returning null rather than throwing, and the raiser then
 * behaves exactly as it did before this seam existed. Push is the fast path, not
 * a new dependency, and the raiser's own discipline of doing one immediate read
 * after subscribing stays intact, because a decision can land between the raise
 * and the subscription and no push channel can deliver what happened before it
 * opened.
 *
 * ── Why the product owns this and the SDK does not ────────────────────────
 *
 * Resolving "which daemon" and proving this surface may subscribe to it are
 * trust-boundary concerns the SDK core deliberately never reaches into (the
 * same carve-out `DaemonVerbCaller` records). The resolution here is the one
 * every other client seam in this repo uses: operator-endpoint.ts.
 */
import { watchApprovalUpdates } from '@pellux/goodvibes-sdk/platform/runtime/client';
import type { ApprovalUpdateSubscriber } from '@pellux/goodvibes-sdk/platform/runtime/client';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveDaemonEnabled } from '@pellux/goodvibes-sdk/platform/config';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveControlPlaneBaseUrl, resolveDaemonStateDirectory } from './operator-endpoint.ts';

export interface TerminalApprovalUpdateSubscriberOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Injectable fetch (tests, or a relay-tunnelled fetch). */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Build the subscriber the SDK raiser takes.
 *
 * Every refusal is a null return, never a throw: this runs on the path that
 * decides a tool call, and a subscription that cannot be opened must degrade to
 * the interval rather than take the ask down with it.
 */
export function createTerminalApprovalUpdateSubscriber(
  options: TerminalApprovalUpdateSubscriberOptions,
): ApprovalUpdateSubscriber {
  return async (onUpdate) => {
    if (!resolveDaemonEnabled(options.configManager)) return null;
    const baseUrl = resolveControlPlaneBaseUrl(options.configManager);
    if (!baseUrl) return null;
    let token: string;
    try {
      const homeDirectory = typeof options.homeDirectory === 'function'
        ? options.homeDirectory()
        : options.homeDirectory;
      token = getOrCreateCompanionToken('tui', {
        daemonHomeDir: resolveDaemonStateDirectory(homeDirectory),
      }).token;
    } catch (error) {
      logger.debug('[approvals] no bearer token could be read for the approval-update stream', {
        error: summarizeError(error),
      });
      return null;
    }
    return await watchApprovalUpdates({
      baseUrl,
      getAuthToken: () => token,
      onUpdate,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  };
}
