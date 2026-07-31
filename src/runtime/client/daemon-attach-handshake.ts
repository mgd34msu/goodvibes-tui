/**
 * daemon-attach-handshake.ts — attaching to a daemon is a handshake, not a
 * pointer swap.
 *
 * ONE `/status` read carries the three things this terminal has to settle
 * before it mirrors anything to a daemon, and as a pure client there is no
 * in-process daemon handle to fold any of them from:
 *
 *  - The DAEMON's own build. Every capability here is something the daemon
 *    performs on this terminal's behalf, so a daemon below this build's floor
 *    is refused rather than adopted — otherwise a verb it does not serve
 *    surfaces as one broken feature instead of as an old daemon, and the
 *    terminal keeps running half-working against a peer it has no reason to
 *    suspect. Refused means local-only, which is a state this app already
 *    renders honestly.
 *  - The minimum CLIENT build the daemon accepts. Below it the guard latches
 *    and the continuation runner stops taking shared-session work.
 *  - Its undelivered receipts (update applied, restarted after a crash,
 *    settings migrated), read from `/status?receipts=consume` where delivery is
 *    destructive — so the read that consumed them is the read that renders
 *    them.
 *
 * Every one of those is decided from the same response, which is why this is
 * one function and not three callers each making their own read.
 *
 * A daemon that goes away and comes back gets the handshake again, off the
 * liveness flip a caller already observes rather than a timer of this module's
 * own: for an already-adopted daemon, coming back up is what its hourly
 * self-update looks like from here, and the build that came back may not be the
 * build that left. The flip an adoption's own first refresh causes runs the
 * handshake once more too; that costs one /status GET and is the price of never
 * having to decide which online flip is "really" a reconnect.
 */

import type { HostServiceStatus } from '@/runtime/index.ts';
import { readExternalDaemonAttach } from '../daemon-attach-notices.ts';
import { ClientBuildGuard, DaemonBuildFloor } from './build-floors.ts';

export interface DaemonAttachHandshakeDeps {
  /** The forward floor's latch — fed the floor this daemon announces. */
  readonly clientBuildGuard: ClientBuildGuard;
  /** The daemon this terminal is currently pointed at. Re-read on every attach. */
  readonly readDaemonStatus: () => HostServiceStatus;
  /**
   * Record a refusal on the status every reader already consults, so the footer
   * and `/status` report "a daemon is there and this build will not adopt it"
   * rather than claiming a working mirror.
   */
  readonly recordRefusal: (status: HostServiceStatus) => void;
  /** Bring the session and memory spines up against this daemon (or take them down). */
  readonly adopt: (status: HostServiceStatus, daemonToken: string) => void;
  /** Where a daemon notice is shown to the owner. */
  readonly notify: (text: string) => void;
  /** This terminal's own floor on the daemon; defaults to the shipped one. */
  readonly daemonFloor?: string | undefined;
  /** Injectable `/status` read for tests. */
  readonly read?: typeof readExternalDaemonAttach | undefined;
}

export interface DaemonAttachHandshake {
  /** Run the handshake against the current daemon status, then adopt or refuse. */
  attach(daemonToken: string): Promise<void>;
  /** Feed the adopted daemon's liveness flips; a flip to online re-handshakes. */
  onLivenessTransition(online: boolean): void;
}

export function createDaemonAttachHandshake(deps: DaemonAttachHandshakeDeps): DaemonAttachHandshake {
  const daemonBuildFloor = new DaemonBuildFloor(deps.daemonFloor);
  const read = deps.read ?? readExternalDaemonAttach;
  let lastDaemonToken: string | null = null;
  // The forward floor's one line. The guard latches in the services graph,
  // where the continuation runner reads it; this is the surface that tells the
  // owner, and a verdict reached before now is held and delivered here.
  deps.clientBuildGuard.onRestartRequired((verdict) => deps.notify(verdict.message));

  const handshake: DaemonAttachHandshake = {
    onLivenessTransition(online) {
      if (online && lastDaemonToken !== null) void handshake.attach(lastDaemonToken);
    },
    async attach(daemonToken) {
      lastDaemonToken = daemonToken;
      const daemonStatus = deps.readDaemonStatus();
      if (daemonStatus.mode !== 'external' || !daemonStatus.baseUrl) {
        deps.adopt(daemonStatus, daemonToken);
        return;
      }
      const answer = await read({
        baseUrl: daemonStatus.baseUrl,
        authToken: daemonToken,
        consumeReceipts: true,
      });
      // Nothing was read, so nothing is known — adopt as before and leave a
      // daemon that is not answering to the spine's own reachability handling.
      // Refusing on a failed read would turn one dropped request into a lost
      // mirror.
      if (!answer.answered) {
        deps.adopt(daemonStatus, daemonToken);
        return;
      }
      const verdict = daemonBuildFloor.evaluate(answer.statusPayload, daemonStatus.baseUrl);
      const notice = daemonBuildFloor.noticeFor(verdict);
      if (notice) deps.notify(notice);
      if (verdict.status === 'daemon-update-required') {
        const refused: HostServiceStatus = { ...daemonStatus, mode: 'incompatible', reason: verdict.message };
        deps.recordRefusal(refused);
        deps.adopt(refused, daemonToken);
        return;
      }
      deps.clientBuildGuard.observeFloor(answer.clientFloor);
      deps.adopt(daemonStatus, daemonToken);
      for (const receipt of answer.notices) deps.notify(receipt);
    },
  };
  return handshake;
}
