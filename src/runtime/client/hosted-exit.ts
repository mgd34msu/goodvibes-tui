/**
 * hosted-exit.ts, leaving a hosted session because the terminal is closing.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * The detach policy is applied when the LAST attached client detaches. A
 * terminal that simply exits never detaches: the daemon keeps this window in
 * `attachedClients` forever, so a `kill`-policy session, the shipped default,
 * and the behavior closing a client has always had, would quietly NOT be
 * killed, and would sit there attached to a process that no longer exists.
 *
 * That is not a cosmetic gap. The owner's ruling is that the capability lands
 * while the familiar default is preserved: quitting ends the work unless the
 * user asked for `survive`. Preserving it requires the quit to actually say so.
 *
 * ── Bounded, and never able to hold the exit open ─────────────────────────
 *
 * The app's shutdown races a hard timeout; a detach is one small round trip to
 * a daemon on loopback, but a daemon that has stopped answering must not add a
 * hang to an exit that is already restoring the user's terminal. So this is
 * bounded on its own and every failure is swallowed after being logged: the
 * worst case is the session keeping a stale attachment, which the daemon's own
 * housekeeping is what resolves, not this process.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createDaemonVerbCaller } from './operator-endpoint.ts';
import { createHostedSessionsClient } from './hosted-sessions.ts';
import { getSharedHostedSessionFeed, type HostedSessionFeed } from '../../panels/hosted-session-feed.ts';

/** How long the exit will wait for the detach before giving up on it. */
export const HOSTED_DETACH_ON_EXIT_TIMEOUT_MS = 1_500;

export interface LeaveHostedSessionOnExitOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** Defaults to the shared feed the `/hosted` command and the panel use. */
  readonly feed?: HostedSessionFeed | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Detach from whatever hosted session this terminal is attached to, so the
 * daemon applies the policy the record has been advertising all along.
 *
 * Resolves to what happened, for a caller that wants to say so: `'none'` when
 * nothing was attached, `'detached'` when the daemon answered, `'failed'` when
 * it did not. Never throws and never runs past its own budget.
 */
export async function leaveHostedSessionOnExit(
  options: LeaveHostedSessionOnExitOptions,
): Promise<'none' | 'detached' | 'failed'> {
  const feed = options.feed ?? getSharedHostedSessionFeed();
  const record = feed.getState().record;
  // Closing the socket is this process's own business and is done either way,
  // an already-terminated session has nothing to detach from, but the stream
  // watching it is still open.
  feed.closeStream();
  if (!record || record.status === 'terminated') return 'none';

  const client = createHostedSessionsClient(createDaemonVerbCaller({
    configManager: options.configManager,
    homeDirectory: options.homeDirectory,
  }));
  const timeoutMs = options.timeoutMs ?? HOSTED_DETACH_ON_EXIT_TIMEOUT_MS;
  try {
    const outcome = await Promise.race([
      client.detach(record.id).then(() => 'detached' as const),
      new Promise<'failed'>((resolve) => {
        const timer = setTimeout(() => resolve('failed'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (outcome === 'failed') {
      logger.debug('[hosted-sessions] the detach-on-exit did not complete in time', {
        sessionId: record.id, timeoutMs,
      });
    }
    return outcome;
  } catch (error) {
    logger.debug('[hosted-sessions] the detach-on-exit was refused', {
      sessionId: record.id, error: summarizeError(error),
    });
    return 'failed';
  }
}
