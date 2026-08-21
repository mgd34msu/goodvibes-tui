// ---------------------------------------------------------------------------
// power-chip-source.ts, the topology-aware source of truth behind the
// always-visible "sleep disabled" chip.
//
// Embedded topology: the in-process PowerManager IS the daemon's, so reading
// getState() per render is already the whole truth; the local runtime bus's
// OPS_POWER_STATE_CHANGED just triggers an immediate repaint so a
// webui-originated toggle (which lands on the same in-process manager) lights
// the chip without waiting for the next natural render.
//
// External/adopted topology: the local manager is NOT the daemon's, and the
// adopted-daemon wire is plain HTTP (no realtime event bridge), so the chip
// POLLS power.status.get on an unref'd interval and renders the DAEMON's
// state, a webui-originated toggle on the daemon lights the TUI chip within
// one poll, and a TUI toggle (forwarded over power.keepAwake.set by
// power-keepawake-remote.ts) lights the webui's the same way. While the
// daemon's state is unknown (fetch pending/unreachable) the local projection
// is served rather than a fabricated one.
// ---------------------------------------------------------------------------

import type { PowerState } from '@pellux/goodvibes-sdk/platform/power';
import { IDLE_POWER_STATE, powerSurfaceFromEvent, powerSurfaceFromState, type PowerStateChangedPayload, type PowerSurfaceState } from './power-status.ts';

export interface PowerChipSourceDeps {
  /** The in-process manager (the whole truth in embedded topology). */
  readonly powerManager: { getState(): PowerState };
  /** Subscribe to the LOCAL bus's OPS_POWER_STATE_CHANGED envelopes; returns unsubscribe. */
  readonly onPowerEvent: (cb: (payload: PowerStateChangedPayload) => void) => () => void;
  /** True only in the external/adopted-daemon topology. */
  readonly isExternalDaemon: () => boolean;
  /** Fetch the DAEMON's power.status.get (null when unreachable). */
  readonly fetchDaemonPowerState: () => Promise<PowerState | null>;
  /** Repaint request when the chip's source state changes. */
  readonly render: () => void;
  /** External-topology poll cadence (default 5000ms; unref'd). */
  readonly pollIntervalMs?: number | undefined;
  readonly timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } | undefined;
}

export interface PowerChipSource {
  /** The current chip projection, daemon-synced in external topology, local otherwise. */
  get(): PowerSurfaceState;
  /** Stop the poll + event subscription. */
  stop(): void;
}

export function createPowerChipSource(deps: PowerChipSourceDeps): PowerChipSource {
  const timers = deps.timers ?? { setInterval, clearInterval };
  let daemonState: PowerSurfaceState | null = null;
  let lastLocal: PowerSurfaceState = IDLE_POWER_STATE;
  let polling = false;

  // Local bus events: immediate repaint (embedded truth changes live).
  const unsubscribe = deps.onPowerEvent((payload) => {
    lastLocal = powerSurfaceFromEvent(payload);
    deps.render();
  });

  const poll = async (): Promise<void> => {
    if (!deps.isExternalDaemon()) {
      if (daemonState !== null) { daemonState = null; deps.render(); }
      return;
    }
    if (polling) return;
    polling = true;
    try {
      const state = await deps.fetchDaemonPowerState();
      const next = state ? powerSurfaceFromState(state) : null;
      const changed = JSON.stringify(next) !== JSON.stringify(daemonState);
      daemonState = next;
      if (changed) deps.render();
    } finally {
      polling = false;
    }
  };
  const interval = timers.setInterval(() => { void poll(); }, deps.pollIntervalMs ?? 5000);
  (interval as { unref?: () => void }).unref?.();
  void poll(); // initial sync so an adopted daemon's held keep-awake shows immediately

  return {
    get(): PowerSurfaceState {
      if (deps.isExternalDaemon() && daemonState !== null) return daemonState;
      // Local truth: prefer a live event projection when one arrived, else read the manager.
      try { return powerSurfaceFromState(deps.powerManager.getState()); } catch { return lastLocal; }
    },
    stop(): void {
      unsubscribe();
      timers.clearInterval(interval);
    },
  };
}
