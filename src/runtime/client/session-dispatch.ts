/**
 * session-dispatch.ts — how work that arrives for a session THIS surface hosts
 * reaches the loop, now that the register is not in this process.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 *
 * The composition used to own a persisting `SharedSessionBroker`, and the
 * broker's `setContinuationRunner` was how the graph said "when a continuation
 * arrives for a session, spawn this". The broker was the register AND the
 * dispatcher, and the terminal app owned both.
 *
 * As a client it owns neither. The daemon holds the register; this surface only
 * needs to RECEIVE dispatch for sessions it is running. That is exactly the
 * `SessionContinuationDispatch` seam the SDK's client shape takes — one method,
 * `setContinuationRunner` — and this module satisfies it over the wire:
 * `sessions.inputs.list` for continuation-intent inputs on the sessions this
 * surface hosts, the bound runner for each, `sessions.inputs.deliver` to
 * acknowledge.
 *
 * ── Discipline (inherited from the spine client, deliberately) ─────────────
 *
 * Every wire call is best-effort and never throws into the render or keystroke
 * path. A failed poll leaves the cursor where it was, so the input is retried
 * next tick; `deliver` is the only de-duplication, because an input already
 * advanced past `queued` is not returned again. Nothing here blocks a turn.
 *
 * ── Why it polls ───────────────────────────────────────────────────────────
 *
 * The same reason the inbound steer poller does (session-inbound-inputs.ts):
 * this is not a hot path — a continuation arrives seconds apart at most — and a
 * poll survives a suspended laptop and a dropped tunnel without a reconnect
 * state machine. The SSE stream carries the same transitions for anything that
 * genuinely needs per-token latency.
 */
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { SharedSessionInputRecord } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SessionContinuationDispatch } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import type { SpineInboundInputsClient } from '../session-inbound-inputs.ts';

/**
 * The runner shape the SDK's dispatch seam binds. Declared structurally rather
 * than imported: `SharedSessionContinuationRunner` lives on a control-plane
 * module the package does not re-export, and re-declaring the two fields a
 * caller passes is honest about how little of it this seam uses.
 */
type ContinuationRunner = Parameters<SessionContinuationDispatch['setContinuationRunner']>[0];

const DEFAULT_INTERVAL_MS = 2_000;

export interface WireSessionDispatchOptions {
  /** The sessions this surface is hosting right now. Re-read every tick. */
  readonly hostedSessionIds: () => readonly string[];
  /** Poll interval; defaults to two seconds. */
  readonly intervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug' | 'info' | 'warn'>;
}

export interface WireSessionDispatch extends SessionContinuationDispatch {
  /** Attach the wire once a daemon has been adopted. Idempotent per base URL. */
  activate(client: SpineInboundInputsClient): void;
  /** Detach; the bound runner is kept so a re-adopted daemon resumes dispatch. */
  deactivate(reason: string): void;
  /** Stop polling entirely. Idempotent. */
  stop(): void;
}

/**
 * A dispatch seam backed by the adopted daemon's session inputs.
 *
 * Inert until `activate` — a surface with no daemon adopted holds its runner and
 * dispatches nothing, which is the honest offline posture rather than a missing
 * dependency.
 */
export function createWireSessionDispatch(options: WireSessionDispatchOptions): WireSessionDispatch {
  const log = options.log ?? logger;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let runner: ContinuationRunner = null;
  let client: SpineInboundInputsClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const drainSession = async (active: SpineInboundInputsClient, sessionId: string): Promise<void> => {
    const bound = runner;
    if (!bound) return;
    const { inputs } = await active.listInputs(sessionId, { state: 'queued', limit: 20 });
    for (const input of inputs) {
      // A `submit` is the continuation case: a message posted into a session
      // THIS surface hosts, which the surface's loop must answer. `steer` and
      // `follow-up` are the live-turn path and belong to the inbound steer
      // poller (session-inbound-inputs.ts), which injects them into the turn
      // already in flight rather than starting a new run.
      if (input.intent !== 'submit') continue;
      try {
        await bound({ sessionId, task: input.body, input: input as SharedSessionInputRecord });
      } catch (error) {
        log.warn('[session dispatch] the bound runner rejected a continuation', {
          sessionId,
          inputId: input.id,
          error: summarizeError(error),
        });
        continue; // leave it queued; a transient runner failure must not consume the work
      }
      await active.deliverInput(sessionId, input.id, { consumed: true });
    }
  };

  const tick = async (): Promise<void> => {
    const active = client;
    if (!active || runner === null || inFlight) return;
    inFlight = true;
    try {
      for (const sessionId of options.hostedSessionIds()) {
        await drainSession(active, sessionId);
      }
    } catch (error) {
      log.debug('[session dispatch] poll failed; retrying next tick', { error: summarizeError(error) });
    } finally {
      inFlight = false;
    }
  };

  const ensureTimer = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
  };

  return {
    setContinuationRunner(next) {
      runner = next;
      if (next !== null && client !== null) ensureTimer();
    },
    activate(next) {
      client = next;
      if (runner !== null) ensureTimer();
      log.info('[session dispatch] adopted the daemon\'s session inputs for continuation dispatch');
    },
    deactivate(reason) {
      client = null;
      log.info(`[session dispatch] detached: ${reason}`);
    },
    stop() {
      if (timer !== null) { clearInterval(timer); timer = null; }
      client = null;
    },
  };
}
