// ---------------------------------------------------------------------------
// power-status.ts, the surface-facing view of host sleep ownership (power.*).
//
// The SDK's PowerManager owns the policy: a keep-awake toggle (daemon-held,
// persisted), automatic work-signal inhibition ("held because X"), and the
// honest lid-split note when idle-sleep can be blocked but lid-close suspend
// can't. This module is the read-only projection every surface renders from,
// the always-visible "sleep disabled" chip, and the ops/status detail lines,
// seeded from powerManager.getState() and kept live by OPS_POWER_STATE_CHANGED.
//
// Owner ruling: the chip IS the safety mechanism. No timers, no AC-only
// options, the keep-awake toggle is exactly one boolean.
// ---------------------------------------------------------------------------

import { LID_SWITCH_HONEST_SPLIT, type PowerState } from '@pellux/goodvibes-sdk/platform/power';

/** The always-visible chip text shown while keep-awake holds (danger-mode idiom). */
export const SLEEP_DISABLED_CHIP = 'sleep disabled';

/** The flattened power state a surface renders from. */
export interface PowerSurfaceState {
  /** The owner keep-awake toggle, the "sleep disabled" chip source. */
  readonly keepAwake: boolean;
  /** True while any sleep inhibitor (work or keep-awake) is held. */
  readonly inhibited: boolean;
  /** Live reasons the WORK inhibitor is held ("held because X"). */
  readonly workReasons: readonly string[];
  /** The honest-split note when part of the requested coverage was refused (verbatim). */
  readonly note: string | null;
}

/** The neutral state (no inhibition, nothing held), the pre-event seed default. */
export const IDLE_POWER_STATE: PowerSurfaceState = {
  keepAwake: false,
  inhibited: false,
  workReasons: [],
  note: null,
};

/** Flatten the full PowerState (power.status.get) into the surface projection. */
export function powerSurfaceFromState(state: PowerState): PowerSurfaceState {
  return {
    keepAwake: state.keepAwake.enabled,
    inhibited: state.keepAwake.held || state.work.held,
    workReasons: state.work.reasons,
    note: state.keepAwake.note,
  };
}

/** The OPS_POWER_STATE_CHANGED payload shape the surface consumes. */
export interface PowerStateChangedPayload {
  readonly inhibited: boolean;
  readonly keepAwake: boolean;
  readonly workReasons: readonly string[];
  readonly note?: string | undefined;
}

/** Flatten an OPS_POWER_STATE_CHANGED event payload into the surface projection. */
export function powerSurfaceFromEvent(ev: PowerStateChangedPayload): PowerSurfaceState {
  return {
    keepAwake: ev.keepAwake,
    inhibited: ev.inhibited,
    workReasons: ev.workReasons,
    note: ev.note ?? null,
  };
}

/**
 * The ops/status detail lines, the honest, plain-language account of sleep
 * ownership. Order: the chip's meaning, then each "held because X" work reason,
 * then the lid-split note VERBATIM when the SDK served it. Empty when nothing
 * is held and no note applies.
 */
export function powerStatusLines(state: PowerSurfaceState): string[] {
  const lines: string[] = [];
  if (state.keepAwake) {
    lines.push(`${SLEEP_DISABLED_CHIP}: keep-awake is on (this host will not idle-sleep)`);
  }
  for (const reason of state.workReasons) {
    lines.push(`held because ${reason}`);
  }
  if (state.note) {
    // The SDK's honest lid-split line, rendered exactly as served.
    lines.push(state.note);
  }
  if (lines.length === 0) {
    lines.push('sleep is not being held; the host sleeps on its own schedule');
  }
  return lines;
}

/** True when the SDK served the honest lid-split note (idle blocked, lid-close is the OS's). */
export function hasLidSplitNote(state: PowerSurfaceState): boolean {
  return state.note === LID_SWITCH_HONEST_SPLIT;
}
