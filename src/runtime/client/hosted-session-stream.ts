/**
 * hosted-session-stream.ts — watching a conversation that is running somewhere
 * else.
 *
 * A hosted session's loop is the ORDINARY Orchestrator, composed inside the
 * daemon. So it emits exactly what a local turn emits — STREAM_DELTA, tool
 * starts, tool results, turn transitions — on the `turn` and `tools` runtime
 * domains, and the control-plane forwards those domains to any subscriber with
 * the session id stamped on every envelope. There is no hosted-only token
 * stream to consume and this file does not invent one: it opens the same event
 * stream a client already uses and keeps the frames whose id matches the
 * session it was told to watch.
 *
 * The third domain is `session`, which carries `hosted-session-update` — the
 * lifecycle channel: created, attached, detached, turn started, turn ended,
 * terminated, restored. That is how an attached terminal learns its session was
 * killed from another surface, or that a turn started that it did not begin.
 *
 * ── Why a refused stream is a value, not a throw ──────────────────────────
 *
 * The same reasoning the SDK's approval-update watcher records: a stream can be
 * refused (no daemon, a 401, a proxy that will not hold a connection), and the
 * caller must still be able to act on the session over the verbs. `watch`
 * resolves to null instead of throwing, and the caller says so honestly rather
 * than pretending the conversation ended.
 */
import { openServerSentEventStream } from '@/runtime/index.ts';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { HostedSessionUpdatePayload } from '@pellux/goodvibes-sdk/platform/hosted-sessions';

/** The domains a hosted session's whole story arrives on. */
export const HOSTED_SESSION_STREAM_DOMAINS = ['turn', 'tools', 'session'] as const;

/** The wire event name the daemon publishes hosted lifecycle notices on. */
export const HOSTED_SESSION_LIFECYCLE_WIRE_EVENT = 'hosted-session-update';

/** One runtime-domain frame, already narrowed to the watched session. */
export interface HostedSessionStreamEvent {
  readonly domain: 'turn' | 'tools';
  /** The runtime event type, e.g. STREAM_DELTA, TOOL_EXECUTING, TURN_COMPLETED. */
  readonly type: string;
  readonly sessionId: string;
  readonly at: number;
  readonly payload: Record<string, unknown>;
}

export interface WatchHostedSessionOptions {
  /** The daemon's base URL, e.g. `http://127.0.0.1:3421`. */
  readonly baseUrl: string;
  /** The hosted session id to keep frames for. Everything else is discarded. */
  readonly sessionId: string;
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  /** Every turn/tools frame belonging to this session. */
  readonly onEvent: (event: HostedSessionStreamEvent) => void;
  /** Every lifecycle transition of this session. */
  readonly onLifecycle?: ((update: HostedSessionUpdatePayload) => void) | undefined;
  /** The stream dropped for good. The caller decides what to say about it. */
  readonly onTerminate?: ((error: unknown) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A live subscription. `close()` is idempotent. */
export interface HostedSessionSubscription {
  close(): void;
}

/**
 * The control-plane events URL narrowed to the three domains a hosted session
 * speaks on. Narrowing matters: an unnarrowed subscriber receives every domain
 * the daemon publishes, which for a client watching one conversation is a great
 * deal of traffic it would immediately discard.
 */
export function hostedSessionStreamUrl(baseUrl: string): string {
  const url = new URL('/api/control-plane/events', baseUrl);
  url.searchParams.set('domains', HOSTED_SESSION_STREAM_DOMAINS.join(','));
  return url.toString();
}

/** Read a serialized runtime envelope, or null when the frame is not one. */
export function readHostedStreamEnvelope(
  domain: 'turn' | 'tools',
  payload: unknown,
): HostedSessionStreamEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as Record<string, unknown>;
  const type = envelope['type'];
  const sessionId = envelope['sessionId'];
  if (typeof type !== 'string' || type.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const body = envelope['payload'];
  return {
    domain,
    type,
    sessionId,
    at: typeof envelope['ts'] === 'number' ? envelope['ts'] : Date.now(),
    payload: typeof body === 'object' && body !== null ? body as Record<string, unknown> : {},
  };
}

/** Read a hosted lifecycle notice, or null when the frame is not one. */
export function readHostedLifecycleNotice(payload: unknown): HostedSessionUpdatePayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const session = record['session'];
  const event = record['event'];
  if (typeof event !== 'string' || typeof session !== 'object' || session === null) return null;
  if (typeof (session as Record<string, unknown>)['id'] !== 'string') return null;
  return record as unknown as HostedSessionUpdatePayload;
}

/**
 * Open a subscription to one hosted session's live output.
 *
 * Resolves to null when the stream could not be opened; the reason is logged
 * once rather than thrown into a keystroke path, and the caller keeps whatever
 * it had (the verbs still work — the conversation is simply not being watched).
 */
export async function watchHostedSession(
  options: WatchHostedSessionOptions,
): Promise<HostedSessionSubscription | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    logger.debug('[hosted-sessions] no fetch implementation is available for the session stream');
    return null;
  }
  const deliver = (event: HostedSessionStreamEvent): void => {
    if (event.sessionId !== options.sessionId) return;
    try {
      options.onEvent(event);
    } catch (error) {
      // A throwing subscriber must not take the stream down for itself.
      logger.debug('[hosted-sessions] a stream subscriber threw', { error: summarizeError(error) });
    }
  };
  try {
    const close = await openServerSentEventStream(
      fetchImpl,
      hostedSessionStreamUrl(options.baseUrl),
      {
        onEvent: (eventName, payload) => {
          if (eventName === 'turn' || eventName === 'tools') {
            const event = readHostedStreamEnvelope(eventName, payload);
            if (event) deliver(event);
            return;
          }
          if (eventName !== HOSTED_SESSION_LIFECYCLE_WIRE_EVENT) return;
          const notice = readHostedLifecycleNotice(payload);
          if (!notice || notice.session.id !== options.sessionId) return;
          try {
            options.onLifecycle?.(notice);
          } catch (error) {
            logger.debug('[hosted-sessions] a lifecycle subscriber threw', { error: summarizeError(error) });
          }
        },
        onTerminate: ({ error }) => options.onTerminate?.(error),
      },
      {
        ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    let closed = false;
    return {
      close: (): void => {
        if (closed) return;
        closed = true;
        close();
      },
    };
  } catch (error) {
    logger.info('[hosted-sessions] the session stream could not be opened; the session is still steerable over its verbs', {
      sessionId: options.sessionId,
      error: summarizeError(error),
    });
    return null;
  }
}
