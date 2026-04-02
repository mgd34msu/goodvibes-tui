/**
 * Default routing policy — maps notification level + domain verbosity to a
 * NotificationTarget. This is the base layer; other policies (quiet-typing,
 * batch) layer on top.
 */

import type {
  DomainVerbosity,
  NotificationLevel,
  NotificationTarget,
} from '../types.ts';

/**
 * Apply the default level-based routing rule.
 *
 * Rules:
 * - `critical` → always `conversation`
 * - `warning`  → `conversation` if verbosity is `normal` or `verbose`, else `status_bar`
 * - `info`     → `panel_only` unless verbosity is `verbose` (then `status_bar`)
 * - `debug`    → always `panel_only`
 *
 * @param level     - Notification severity level.
 * @param verbosity - Per-domain verbosity setting.
 * @returns The base routing target before suppression/batch policies apply.
 */
export function applyDefaultPolicy(
  level: NotificationLevel,
  verbosity: DomainVerbosity
): NotificationTarget {
  switch (level) {
    case 'critical':
      return 'conversation';

    case 'warning':
      return verbosity === 'normal' || verbosity === 'verbose'
        ? 'conversation'
        : 'status_bar';

    case 'info':
      return verbosity === 'verbose' ? 'status_bar' : 'panel_only';

    case 'debug':
      return 'panel_only';
  }
}
