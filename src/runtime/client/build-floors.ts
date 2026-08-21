/**
 * build-floors.ts, the two build floors this terminal and the daemon hold
 * against each other.
 *
 * ── Forward: the daemon's floor on this client ────────────────────────────
 *
 * A daemon update swaps the daemon binary and nothing else. This terminal keeps
 * running the build it started with: same rules, same bugs, still registered in
 * the shared session store, still able to execute shared-session work. That is
 * how a behavioral fix can land in the daemon, be verified present in the
 * installed binaries, and still not change what the owner observes, an older
 * terminal beside the new daemon simply keeps doing the old thing.
 *
 * So the daemon publishes the minimum client build it will let participate, as
 * an `X-Goodvibes-Client-Floor` response header on `/status`. Below that floor
 * this terminal says so plainly and stops taking shared-session work, rather
 * than quietly executing under superseded rules until someone notices.
 *
 * ── Reverse: this client's floor on the daemon ────────────────────────────
 *
 * The exposure runs the other way too. This terminal is a pure client: it talks
 * to a daemon it did not start, over a base URL that may point at another
 * machine, and every capability it has is something the daemon performs on its
 * behalf. A verb it depends on may simply not exist in the build that answers,
 * and what the owner sees then is a 400 or a 404 on one call, which reads as a
 * broken feature rather than as an old daemon. So this terminal declares the
 * oldest daemon build it can work against and checks it on attach against the
 * `version` `/status` already returns, refusing to adopt a daemon below it.
 *
 * ── Where these rules live ────────────────────────────────────────────────
 *
 * Both comparisons, the header name, the verdict shapes, the version ordering
 *, are owned by the SDK (platform/control-plane/client-compatibility.ts and
 * daemon-compatibility.ts) and imported below rather than duplicated. What
 * stays here is this process's own state: the forward latch, the reverse
 * announce-once, and the daemon floor this product declares. The agent holds
 * the same forward latch shape for its own process lifetime, which is why the
 * latch is not a value the SDK ships.
 */

import {
  evaluateClientCompatibility,
  evaluateDaemonStatusCompatibility,
  type ClientCompatibilityVerdict,
  type DaemonCompatibilityVerdict,
} from '@pellux/goodvibes-sdk/platform/control-plane';

/**
 * The oldest daemon build this terminal will adopt.
 *
 * 1.28.0 is the daemon release in which the daemon became its own product and
 * this terminal became a pure client of it: the session register, the inbound
 * steer queue, the fleet needs-input push and the credential writes this build
 * calls are all served there. An older daemon answers some of those and not
 * others, which is the half-working state this floor exists to stop.
 *
 * Raise this only for a daemon behavior this terminal MUST have, and say in the
 * release notes what it was raised for. It costs a daemon update for anyone
 * running an older one.
 */
export const TUI_DAEMON_BUILD_FLOOR = '1.28.0';

export interface ClientBuildGuardOptions {
  readonly clientVersion: string;
}

/**
 * The live forward verdict for this process, updated by whatever reads the
 * daemon's floor (the attach handshake) and consulted by whatever would execute
 * shared-session work (the continuation runner).
 *
 * Latching is deliberate: once a daemon has told this process it is too old, a
 * later read that fails to see the header (a restart, a truncated response)
 * must not silently re-enable work.
 *
 * The notice sink is attached after construction, this guard is built in the
 * services composition root, and the surface that renders its one line is wired
 * in the bootstrap tail. A verdict reached before the sink attaches is held and
 * delivered on attach, the same buffered-until-attach idiom the daemon receipt
 * notices use, so a refusal is never the message nobody saw.
 */
export class ClientBuildGuard {
  private verdict: ClientCompatibilityVerdict;
  private announced = false;
  private notify: ((verdict: ClientCompatibilityVerdict) => void) | null = null;
  private pending: ClientCompatibilityVerdict | null = null;

  constructor(private readonly options: ClientBuildGuardOptions) {
    this.verdict = {
      status: 'ok',
      message: 'No daemon floor observed yet.',
      clientVersion: options.clientVersion,
      floor: undefined,
    };
  }

  /**
   * Attach the surface that renders the one line telling the owner to restart.
   * Flushes a verdict already reached before this call.
   */
  onRestartRequired(notify: (verdict: ClientCompatibilityVerdict) => void): void {
    this.notify = notify;
    const held = this.pending;
    this.pending = null;
    if (held) notify(held);
  }

  /** Feed a floor read from a daemon `/status` response. */
  observeFloor(floor: string | undefined): ClientCompatibilityVerdict {
    if (this.verdict.status === 'restart-required') return this.verdict;
    const next = evaluateClientCompatibility({ clientVersion: this.options.clientVersion, floor });
    this.verdict = next;
    if (next.status === 'restart-required' && !this.announced) {
      this.announced = true;
      if (this.notify) this.notify(next);
      else this.pending = next;
    }
    return next;
  }

  /** False once this build has been judged too old for the live daemon. */
  maySharedSessionWork(): boolean {
    return this.verdict.status !== 'restart-required';
  }

  current(): ClientCompatibilityVerdict {
    return this.verdict;
  }
}

/**
 * The reverse half: this terminal's verdict on the daemon answering at a base
 * URL, held across attaches so a reconnect loop against one old daemon states
 * the problem once instead of on every poll.
 *
 * Unlatched, unlike the forward guard: a daemon CAN become new enough while
 * this terminal runs, that is exactly what a daemon update does, and the
 * attach that sees the newer build must adopt it. What is remembered is only
 * which sentence has already been said.
 */
export class DaemonBuildFloor {
  private announced: string | null = null;

  constructor(private readonly floor: string = TUI_DAEMON_BUILD_FLOOR) {}

  /**
   * Judge a parsed `/status` body. `daemonLabel` names the peer in the sentence
   * so an operator with two daemons on the LAN learns WHICH one is old.
   */
  evaluate(statusPayload: unknown, daemonLabel: string): DaemonCompatibilityVerdict {
    return evaluateDaemonStatusCompatibility(statusPayload, this.floor, daemonLabel);
  }

  /**
   * The line to show for a verdict, or null when this exact sentence has
   * already been shown (or there is nothing to say).
   */
  noticeFor(verdict: DaemonCompatibilityVerdict): string | null {
    if (verdict.status === 'ok') {
      this.announced = null;
      return null;
    }
    if (this.announced === verdict.message) return null;
    this.announced = verdict.message;
    return verdict.message;
  }
}
