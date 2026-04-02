/**
 * UIEvent — discriminated union covering UI render, scroll, and panel events.
 *
 * These events drive the TUI rendering layer without coupling it to business logic.
 */

export type UIEvent =
  /** A full re-render has been requested. */
  | { type: 'UI_RENDER_REQUEST' }
  /** Scroll by a relative delta (positive = down, negative = up). */
  | { type: 'UI_SCROLL_DELTA'; delta: number }
  /** Scroll to an absolute line number. */
  | { type: 'UI_SCROLL_TO'; line: number }
  /** A collapsible block's collapsed state was toggled. */
  | { type: 'UI_BLOCK_TOGGLE_COLLAPSE'; blockIndex: number }
  /** A block was requested to re-run. */
  | { type: 'UI_BLOCK_RERUN'; blockIndex: number; content: string }
  /** The screen was cleared. */
  | { type: 'UI_CLEAR_SCREEN' }
  /** A panel was opened. */
  | { type: 'UI_PANEL_OPEN'; panelId: string }
  /** A panel was closed. */
  | { type: 'UI_PANEL_CLOSE'; panelId: string }
  /** A panel was focused. */
  | { type: 'UI_PANEL_FOCUS'; panelId: string }
  /** The active view changed (e.g. chat -> search -> help). */
  | { type: 'UI_VIEW_CHANGED'; from: string; to: string };

/** All UI event type literals as a union. */
export type UIEventType = UIEvent['type'];
