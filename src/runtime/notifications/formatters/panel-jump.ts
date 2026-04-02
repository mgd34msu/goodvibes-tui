/**
 * Panel jump action generator — creates NotificationAction objects that
 * instruct the UI to focus a specific panel. These actions are attached to
 * conversation-surface notifications so the user can jump directly from a
 * summary to the relevant panel for full detail.
 */

import type { NotificationAction } from '../types.ts';

/**
 * Create a "Jump to panel" action for a given panel ID.
 *
 * @param panelId - The panel to navigate to on activation.
 * @param label   - Optional custom label (defaults to "Jump to panel").
 * @returns A NotificationAction of type `jump_to_panel`.
 */
export function createPanelJumpAction(
  panelId: string,
  label = 'Jump to panel'
): NotificationAction {
  return {
    label,
    type: 'jump_to_panel',
    panelId,
  };
}

/**
 * Create a dismiss action for a notification.
 *
 * @param label - Optional custom label (defaults to "Dismiss").
 * @returns A NotificationAction of type `dismiss`.
 */
export function createDismissAction(label = 'Dismiss'): NotificationAction {
  return {
    label,
    type: 'dismiss',
  };
}
