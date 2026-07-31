/**
 * conversation-rewind-host.ts — this surface answering the daemon's questions
 * about a conversation only it is holding.
 *
 * ── What was broken ───────────────────────────────────────────────────────
 *
 * Files rewind works from anywhere, because the workspace checkpoint store is
 * the daemon's. The conversation half is answerable only by the process running
 * the loop, and once the surfaces became pure clients that process is not the
 * daemon. The daemon's in-process conversation registry — which nothing outside
 * the daemon could populate — answered "0 messages to drop" for every session
 * hosted elsewhere: a confident answer to a question it could not reach.
 *
 * This module is the other end of the fix. The surface OFFERS the conversation
 * it is running; the daemon then asks that surface when a rewind touches it.
 *
 * ── Why a poll, and why it is not a poll ──────────────────────────────────
 *
 * This is a reverse call: the daemon asking a connected client and awaiting an
 * answer while a `rewind.plan` call waits on it. The delivery is a `take` that
 * the surface holds open — a long poll, not a tight loop. With nothing waiting
 * the call parks for up to the daemon's own ceiling and returns empty; with
 * work waiting it returns immediately. So the steady state is one open request,
 * not repeated requests, and an answer starts moving the instant the question
 * is raised.
 *
 * The same call renews the lease. A surface that is polling is a surface that
 * is alive, so there is no separate keepalive to get out of step with it — and
 * a crashed surface simply stops being consulted when its lease lapses, with
 * nobody cleaning up after it.
 *
 * ── Answering honestly ────────────────────────────────────────────────────
 *
 * A question about a session this process is NOT holding is answered
 * `unavailable` with the reason, never zero. That distinction is the whole
 * point: a real zero and an unreachable conversation look identical as numbers,
 * and reporting the second as the first is what made the old behaviour a lie
 * rather than a gap.
 *
 * Every failure path resolves. A request that throws while being answered is
 * answered `unavailable` with the error text rather than left to time out, so
 * the waiting `rewind.plan` gets a reason instead of a stall.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { ConversationRewindPort } from '../conversation-rewind-port.ts';
import type { DaemonVerbCaller } from './operator-endpoint.ts';

/** How long a `take` is held open. Under the daemon's 25s ceiling by design. */
const DEFAULT_WAIT_MS = 20_000;
/** How long to wait before retrying after a transport failure. */
const RETRY_BACKOFF_MS = 3_000;

/** One question, as the wire delivers it. */
interface HostRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly kind: 'preview' | 'rewind';
  readonly expiresAt: number;
}

export interface ConversationRewindHostOptions {
  readonly verbs: DaemonVerbCaller;
  /** The port that answers — this process's own conversations, by session id. */
  readonly port: ConversationRewindPort;
  /** Whether this process is actually holding that session's conversation. */
  readonly hosts: (sessionId: string) => boolean;
  /** How this surface names itself in the refusals a person reads. */
  readonly label?: string;
  readonly waitMs?: number;
  readonly retryBackoffMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ConversationRewindHostClient {
  /**
   * Name the session whose conversation this surface is holding, without
   * starting the polling loop. The registration itself happens on the first
   * `pump`, so a caller that wants to drive the cycles deterministically — a
   * test, or a one-shot check — uses `offer` + `pump` and never has two takes
   * racing on one host id.
   */
  offer(sessionId: string): void;
  /** `offer`, plus the loop that keeps taking questions. Idempotent per session. */
  start(sessionId: string): void;
  /** Withdraw the offer and stop. Idempotent; safe to call with nothing running. */
  stop(): Promise<void>;
  /** The host id the daemon issued, once registered. Null before that. */
  hostId(): string | null;
  /** One take-and-answer cycle: register if needed, take, answer each question. */
  pump(): Promise<number>;
}

export function createConversationRewindHost(options: ConversationRewindHostOptions): ConversationRewindHostClient {
  const log = options.log ?? logger;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const backoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));

  let sessionId: string | null = null;
  let currentHostId: string | null = null;
  let running = false;
  let loop: Promise<void> | null = null;

  /** Claim the session. Returns the host id, or null when the daemon refused. */
  const register = async (): Promise<string | null> => {
    if (!sessionId) return null;
    try {
      const result = await options.verbs.invoke<{ host?: { hostId?: string } }>(
        'rewind.conversation.host.register',
        { sessionId, label: options.label ?? 'the terminal app' },
      );
      const hostId = result?.host?.hostId ?? null;
      if (hostId) {
        log.info(`[rewind] offered this session's conversation to the daemon (host ${hostId})`);
      }
      return hostId;
    } catch (error) {
      log.debug('[rewind] offering this conversation to the daemon failed', { error: summarizeError(error) });
      return null;
    }
  };

  /** Build the answer for one question — or the honest reason there is none. */
  const answerFor = async (request: HostRequest): Promise<Record<string, unknown>> => {
    if (!options.hosts(request.sessionId)) {
      // Never zero. A real zero and a conversation this process is not holding
      // are indistinguishable as a number, and reporting the second as the
      // first is precisely the failure this contract exists to end.
      return {
        unavailableReason: `this surface is no longer holding the conversation for session ${request.sessionId}`,
      };
    }
    const anchor = { sessionId: request.sessionId, turnId: request.turnId ?? undefined } as Parameters<ConversationRewindPort['preview']>[0];
    if (request.kind === 'preview') {
      const preview = await options.port.preview(anchor);
      return { messagesToDrop: preview.messagesToDrop, messagesRemaining: preview.messagesRemaining };
    }
    const outcome = await options.port.rewind(anchor);
    return { droppedMessages: outcome.droppedMessages, undoSnapshotId: outcome.undoSnapshotId };
  };

  const answer = async (hostId: string, request: HostRequest): Promise<void> => {
    let payload: Record<string, unknown>;
    try {
      payload = await answerFor(request);
    } catch (error) {
      // Answered, not dropped: a `rewind.plan` is waiting on this, and a reason
      // reaches the person faster and more usefully than a timeout does.
      payload = { unavailableReason: `the surface hosting this conversation could not answer: ${summarizeError(error)}` };
    }
    try {
      await options.verbs.invoke('rewind.conversation.requests.answer', {
        hostId, requestId: request.requestId, ...payload,
      });
    } catch (error) {
      // A 409 here means the question stopped waiting — it expired, or another
      // surface took the session over. Nothing to do but say so.
      log.debug('[rewind] the daemon would not accept this answer', {
        requestId: request.requestId, error: summarizeError(error),
      });
    }
  };

  const pump = async (): Promise<number> => {
    if (!sessionId) return 0;
    if (!currentHostId) {
      currentHostId = await register();
      if (!currentHostId) return 0;
    }
    const hostId = currentHostId;
    let taken: { requests?: readonly HostRequest[] } | null = null;
    try {
      taken = await options.verbs.invoke<{ requests?: readonly HostRequest[] }>(
        'rewind.conversation.requests.take',
        { hostId, waitMs },
      );
    } catch (error) {
      // The registration is gone (lease lapsed, daemon restarted, another
      // surface claimed the session). Drop the host id so the next cycle
      // re-offers rather than polling an id nobody knows.
      currentHostId = null;
      log.debug('[rewind] taking conversation-rewind questions failed; will re-offer', {
        error: summarizeError(error),
      });
      return 0;
    }
    const requests = taken?.requests ?? [];
    for (const request of requests) await answer(hostId, request);
    return requests.length;
  };

  const run = async (): Promise<void> => {
    while (running) {
      const handled = await pump();
      // Only back off when nothing was registered or the take failed. A
      // successful empty take already consumed its own wait, so looping
      // straight back into it is one open request, not a busy loop.
      if (!currentHostId) await sleep(backoffMs);
      else if (handled === 0 && waitMs === 0) await sleep(backoffMs);
    }
  };

  const offer = (nextSessionId: string): boolean => {
    if (!nextSessionId) return false;
    if (sessionId === nextSessionId) return true;
    sessionId = nextSessionId;
    currentHostId = null;
    return true;
  };

  return {
    offer(nextSessionId: string): void { offer(nextSessionId); },

    start(nextSessionId: string): void {
      if (!offer(nextSessionId)) return;
      if (running) return;
      running = true;
      loop = run().catch((error) => {
        log.warn('[rewind] the conversation-host loop stopped', { error: summarizeError(error) });
      });
    },

    async stop(): Promise<void> {
      running = false;
      const hostId = currentHostId;
      const session = sessionId;
      currentHostId = null;
      sessionId = null;
      if (hostId && session) {
        try {
          await options.verbs.invoke('rewind.conversation.host.release', { sessionId: session, hostId });
          log.info('[rewind] withdrew this session\'s conversation from the daemon');
        } catch (error) {
          // A lapsed lease reaches the same end state, so this is worth saying
          // once and never worth failing a shutdown over.
          log.debug('[rewind] releasing the conversation host failed', { error: summarizeError(error) });
        }
      }
      loop = null;
    },

    hostId: () => currentHostId,
    pump,
  };
}
