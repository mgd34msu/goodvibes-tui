/**
 * alert-gating — shared config + focus gating logic for the unfocused-user
 * alert classes (budget-breach, long-task, agent/chain failure,
 * awaiting-approval). Each alert class has its own on/off config key
 * (default true); a single master key, `behavior.notifyOnlyWhenUnfocused`
 * (default true), decides whether any of them additionally require the
 * terminal to be unfocused-or-unknown before firing.
 *
 * Extracted so every alert-class module (long-task-notifier.ts,
 * budget-breach-notifier.ts, approval-alert.ts, and the agent/chain-failure
 * wiring in turn-event-wiring.ts) shares one implementation of "should this
 * fire right now" instead of re-deriving the same two config reads and the
 * same focus check.
 */
import type { FocusTracker } from './focus-tracker.ts';

/** Minimal config-read surface every gating check needs. */
export type ConfigGet = (key: string) => unknown;

/** Read a TUI-local synthetic boolean setting, defaulting when absent/invalid. */
export function readBooleanConfig(configGet: ConfigGet, key: string, defaultValue: boolean): boolean {
  const raw = configGet(key);
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return defaultValue;
  // Tolerate string/number forms the same way the rest of the config layer does
  // (settings-modal writes real booleans, but env/file edits may not).
  if (raw === 'true' || raw === 1) return true;
  if (raw === 'false' || raw === 0) return false;
  return defaultValue;
}

/** `behavior.notifyOnlyWhenUnfocused` — master gate, default on. */
export function readNotifyOnlyWhenUnfocused(configGet: ConfigGet): boolean {
  return readBooleanConfig(configGet, 'behavior.notifyOnlyWhenUnfocused', true);
}

/**
 * Decide whether a given alert class should fire right now.
 *
 * `classConfigKey` is the per-class on/off switch (e.g.
 * 'behavior.notifyOnBudgetBreach'); default true when absent. When that key
 * is off, the class never fires regardless of focus. When it's on, the
 * result additionally depends on the master `notifyOnlyWhenUnfocused` gate:
 * if that master gate is off, the class fires unconditionally (today's
 * pre-focus-tracking behavior); if on (the default), it only fires when the
 * terminal is unfocused or focus state was never observed (see
 * FocusTracker.shouldAlertWhenUnfocused).
 */
export function shouldFireAlert(
  focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>,
  configGet: ConfigGet,
  classConfigKey: string,
): boolean {
  if (!readBooleanConfig(configGet, classConfigKey, true)) return false;
  if (!readNotifyOnlyWhenUnfocused(configGet)) return true;
  return focusTracker.shouldAlertWhenUnfocused();
}

/**
 * notifyCompletion (SDK platform/utils) only rings the bell above 5s of
 * "duration" and only pops a desktop notification above 30s — a heuristic
 * tuned for long-running-turn notifications. The alert classes in this
 * directory are point-in-time events with no natural duration, so they pass
 * this constant as the `durationMs` argument to force both the bell and the
 * desktop popup unconditionally.
 */
export const FORCE_NOTIFY_DURATION_MS = 30_001;
