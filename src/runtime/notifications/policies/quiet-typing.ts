/**
 * Quiet-while-typing policy — suppresses non-critical notifications when
 * the user is actively composing input, preventing distracting UI churn
 * mid-keystroke.
 */

import type { NotificationLevel, NotificationTarget } from '../types.ts';

/**
 * Levels that are immune to quiet-while-typing suppression.
 * Critical notifications always surface regardless of typing state.
 */
const UNSUPPRESSABLE_LEVELS = new Set<NotificationLevel>(['critical']);

/**
 * Determines if a notification at the given level and target should be
 * suppressed while the user is actively typing.
 *
 * - `critical` — never suppressed
 * - `warning` / `info` / `debug` — suppressed when quiet mode is active
 *   AND the resolved target would surface above `panel_only`
 *
 * @param level         - Notification severity level.
 * @param target        - The target resolved by prior policies.
 * @param quietEnabled  - Whether quiet-while-typing mode is currently active.
 * @returns Suppression reason string if suppressed, undefined otherwise.
 */
export function applyQuietTypingPolicy(
  level: NotificationLevel,
  target: NotificationTarget,
  quietEnabled: boolean
): string | undefined {
  if (!quietEnabled) {
    return undefined;
  }

  if (UNSUPPRESSABLE_LEVELS.has(level)) {
    return undefined;
  }

  // Only suppress notifications that would appear above panel_only.
  // panel_only notifications are already silent; suppressing them is a no-op.
  if (target === 'panel_only') {
    return undefined;
  }

  return 'quiet_while_typing';
}
