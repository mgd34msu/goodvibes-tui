/**
 * session-inbound-inputs.ts
 *
 * D3 (One-Platform Wave 2, live-surface steer delivery — the inbound half of the
 * session spine): the TUI's INBOUND path for steer/follow-up inputs that another
 * live surface (e.g. the webui) queued against THIS TUI's session.
 *
 * Charter: when the owning surface is LIVE (heartbeating within the daemon's
 * SURFACE_ROUTE_FRESHNESS window), a steer is DELIVERED to that surface rather
 * than spawning a daemon-side executor (which would fail on the daemon's empty
 * model registry). The daemon already does its half — `sessions.steer` /
 * `sessions.followUp` to a surface-managed session with a fresh participant
 * QUEUES the input for the surface (mode 'queued-for-surface') instead of
 * spawning. This poller is the surface completing that contract:
 *
 *   1. poll `sessions.inputs.list` for QUEUED inputs on ITS OWN sessionId
 *      (the query is scoped by sessionId, so a steer for another session can
 *      never land here — the per-session isolation the concurrent-sessions
 *      charter requires);
 *   2. hand each steer/follow-up to `onSteer` (the surface-side injection into
 *      the TUI's turn machinery — narrate "steer received from <surface>" and
 *      fire the next-turn boundary), skipping the TUI's own submissions;
 *   3. acknowledge on the wire via `sessions.inputs.deliver` (queued → delivered)
 *      so every surface sees delivery truth live and the input is not re-picked.
 *
 * Discipline (mirrors SessionSpineClient): every wire call is best-effort and
 * never throws into the render/keystroke path; a failed poll leaves the cursor
 * where it was so the input is retried on the next tick (deliver is the only
 * de-dup — an input already advanced past 'queued' is not returned again).
 */

import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
} from '@pellux/goodvibes-sdk/platform/control-plane';

/** The TUI's own participant surfaceId — inputs it authored are never re-injected. */
export const TUI_SURFACE_ID = 'surface:tui';

/** The narrow inbound wire surface this poller needs. Structurally satisfied by
 * the http operator client's `sessions.inputs` (list + deliver). Typed against
 * this shape rather than the concrete client so tests inject a stub. */
export interface SpineInboundInputsClient {
  listInputs(
    sessionId: string,
    options: { readonly state?: string; readonly since?: number; readonly limit?: number },
  ): Promise<{ readonly inputs: readonly SharedSessionInputRecord[] }>;
  deliverInput(
    sessionId: string,
    inputId: string,
    options?: { readonly consumed?: boolean },
  ): Promise<unknown>;
}

/** A steer/follow-up collected from the wire for surface-side injection. */
export interface InboundSteer {
  readonly inputId: string;
  readonly sessionId: string;
  readonly intent: SharedSessionInputIntent;
  readonly body: string;
  readonly surfaceKind: string | undefined;
  readonly surfaceId: string | undefined;
  readonly displayName: string | undefined;
}

type InboundLogger = Pick<typeof logger, 'debug' | 'info'>;

export interface SessionInboundInputPollerOptions {
  /** Returns the TUI's current live sessionId, or null when there is none yet.
   * Read on every tick so a session swap re-targets the poll automatically. */
  readonly sessionId: () => string | null;
  /** Surface-side injection: narrate + deliver the steer into the turn machinery. */
  readonly onSteer: (steer: InboundSteer) => void;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: InboundLogger;
  /** The poller's own surfaceId — inputs it authored are skipped (default TUI). */
  readonly ownSurfaceId?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 4_000;

export class SessionInboundInputPoller {
  private readonly sessionId: () => string | null;
  private readonly onSteer: (steer: InboundSteer) => void;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: InboundLogger;
  private readonly ownSurfaceId: string;

  private client: SpineInboundInputsClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Exclusive createdAt cursor, per session — a session swap resets it. */
  private cursor = 0;
  private cursorSessionId: string | null = null;

  constructor(options: SessionInboundInputPollerOptions) {
    this.sessionId = options.sessionId;
    this.onSteer = options.onSteer;
    this.intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? logger;
    this.ownSurfaceId = options.ownSurfaceId ?? TUI_SURFACE_ID;
  }

  /** Whether a backend is attached (external daemon adopted). */
  get active(): boolean {
    return this.client !== null;
  }

  /**
   * Attach the wire client and begin polling (external daemon adopted). Idempotent:
   * re-activating swaps the client without stacking timers.
   */
  activate(client: SpineInboundInputsClient): void {
    this.client = client;
    if (this.timer === null) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.intervalMs);
      this.timer.unref?.();
    }
    this.log.info('session inbound-input poller activated — collecting queued steers for this surface', {});
  }

  /** Detach the backend and stop polling (daemon mode resolved to non-external, or lost). */
  deactivate(reason: string): void {
    this.client = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info('session inbound-input poller deactivated', { reason });
  }

  /** Stop the timer (shutdown). */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll pass: collect queued steer/follow-up inputs for the current session,
   * inject each, and acknowledge delivery. Returns the number of steers delivered.
   * Best-effort: any wire error is absorbed and the pass is retried next tick.
   */
  async pollOnce(): Promise<number> {
    const client = this.client;
    if (!client || this.polling) return 0;
    const sessionId = this.sessionId();
    if (!sessionId) return 0;

    // A session swap resets the cursor so we never skip the new session's backlog.
    if (sessionId !== this.cursorSessionId) {
      this.cursor = 0;
      this.cursorSessionId = sessionId;
    }

    this.polling = true;
    let delivered = 0;
    try {
      const result = await client.listInputs(sessionId, { state: 'queued', since: this.cursor });
      const inputs = result?.inputs ?? [];
      for (const input of inputs) {
        // Advance the cursor across every queued input we observe (even skipped
        // ones) so it is monotonic; deliver() is the real de-dup for injected ones.
        if (input.createdAt > this.cursor) this.cursor = input.createdAt;

        if (input.state !== 'queued') continue;
        if (input.intent !== 'steer' && input.intent !== 'follow-up') continue;
        // Never re-inject this surface's OWN submissions.
        if (input.surfaceId === this.ownSurfaceId) continue;

        const steer: InboundSteer = {
          inputId: input.id,
          sessionId,
          intent: input.intent,
          body: input.body,
          surfaceKind: input.surfaceKind,
          surfaceId: input.surfaceId,
          displayName: input.displayName,
        };
        try {
          this.onSteer(steer);
        } catch (error) {
          // A failing injection must not wedge the poll loop or drop the ack —
          // narrate-and-continue; the input is still acked so it is not re-picked.
          this.log.debug('session inbound steer injection threw — continuing', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          // consumed:false → queued → delivered (surface has collected it).
          await client.deliverInput(sessionId, input.id, { consumed: false });
          delivered += 1;
        } catch (error) {
          this.log.debug('session inbound deliver ack failed — will retry', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      // Poll failed entirely (daemon gone, transient): keep the cursor, retry next tick.
      this.log.debug('session inbound-input poll failed — retry next tick', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
    return delivered;
  }
}

/** Format the operator-facing narration for an inbound steer, e.g.
 * "steer received from webui (Alice): resize the panel". */
export function narrateInboundSteer(steer: InboundSteer): string {
  const surface = steer.surfaceKind ?? steer.surfaceId ?? 'another surface';
  const who = steer.displayName ? ` (${steer.displayName})` : '';
  const verb = steer.intent === 'follow-up' ? 'follow-up received from' : 'steer received from';
  return `${verb} ${surface}${who}: ${steer.body}`;
}
