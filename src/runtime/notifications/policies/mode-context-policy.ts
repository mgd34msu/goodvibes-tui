/**
 * Mode-context policy — applies HITL-mode-aware suppression on top of the
 * base routing decision.
 *
 * In `quiet` mode (minimal verbosity), non-critical, non-milestone
 * notifications that would surface above `panel_only` are suppressed. This
 * aggressively clears operational churn from the main conversation and
 * status bar while the user is in a low-interruption session.
 *
 * In `balanced` mode, `operational`-tagged `info` notifications are
 * suppressed but warnings are allowed through (matching the existing default
 * policy behaviour).
 *
 * In `operator` mode, no additional suppression is applied — all
 * notifications surface as-is.
 */

import type {
  DomainVerbosity,
  NotificationLevel,
  NotificationTag,
  NotificationTarget,
  RoutingReasonCode,
} from '../types.ts';

/**
 * Tags that are always allowed through regardless of mode.
 * Milestones and alerts are user-facing events, not operational churn.
 */
const ALWAYS_ALLOWED_TAGS = new Set<NotificationTag>(['milestone', 'alert']);

/**
 * Levels that are immune to mode-context suppression.
 * Critical notifications always surface.
 */
const UNSUPPRESSABLE_LEVELS = new Set<NotificationLevel>(['critical']);

/**
 * Apply the mode-context suppression policy.
 *
 * @param level       - Notification severity level.
 * @param target      - The routing target resolved by prior policies.
 * @param tag         - Optional semantic tag classifying the notification.
 * @param verbosity   - The effective domain verbosity (from HITL preset + overrides).
 * @returns A RoutingReasonCode for the decision, or undefined if not suppressed.
 */
export function applyModeContextPolicy(
  level: NotificationLevel,
  target: NotificationTarget,
  tag: NotificationTag | undefined,
  verbosity: DomainVerbosity
): RoutingReasonCode | undefined {
  // panel_only is already silent — suppression is a no-op.
  if (target === 'panel_only') {
    return undefined;
  }

  // Critical notifications always surface.
  if (UNSUPPRESSABLE_LEVELS.has(level)) {
    return undefined;
  }

  // Milestone and alert tags are never suppressed by mode context.
  if (tag !== undefined && ALWAYS_ALLOWED_TAGS.has(tag)) {
    return undefined;
  }

  // Minimal verbosity: suppress everything except critical/milestone/alert.
  if (verbosity === 'minimal') {
    return 'mode_context_minimal';
  }

  // Normal verbosity: suppress operational info notifications.
  if (verbosity === 'normal') {
    const effectiveTag: NotificationTag = tag ?? 'operational';
    if (level === 'info' && effectiveTag === 'operational') {
      return 'mode_context_normal';
    }
  }

  // Verbose verbosity: no additional suppression.
  return undefined;
}
