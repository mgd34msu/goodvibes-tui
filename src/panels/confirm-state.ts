// ---------------------------------------------------------------------------
// useConfirmState<T> — reusable inline y/n confirmation helper
//
// Pattern (chosen over ConfirmableListPanel base class):
//   - Composable: any panel holds a ConfirmState field, not a new base class
//   - Identical y/n UX everywhere: y confirms, n/Esc cancels, any other key
//     is absorbed (does nothing) while confirm is active
//   - Render: caller calls renderConfirmLines(width, state) to get the two
//     lines that replace the normal content area when confirming
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { buildPanelLine } from './polish.ts';
import { DEFAULT_PANEL_PALETTE } from './polish.ts';

export interface ConfirmState<T = string> {
  /** The subject of the confirmation (e.g. item name or id). */
  readonly subject: T;
  /** Human-readable label for the item being destroyed. */
  readonly label: string;
}

/**
 * Call this from a panel's handleInput() BEFORE any other key handling.
 *
 * Returns:
 *   - `'confirmed'` — user pressed y; caller must execute the action and
 *     clear state (set confirm to null)
 *   - `'cancelled'` — user pressed n or Esc; caller must clear state
 *   - `'absorbed'`  — any other key while confirm is active; caller returns true
 *   - `'inactive'`  — no confirm pending; caller continues normal dispatch
 */
export function handleConfirmInput<T = string>(
  confirm: ConfirmState<T> | null,
  key: string,
): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
  if (!confirm) return 'inactive';
  if (key === 'y') return 'confirmed';
  if (key === 'n' || key === 'escape') return 'cancelled';
  return 'absorbed';
}

/**
 * Build the two confirmation lines to show in place of the normal list body.
 * Callers embed these lines in a workspace section titled 'Confirmation'.
 */
export function renderConfirmLines<T = string>(width: number, state: ConfirmState<T>): Line[] {
  const palette = DEFAULT_PANEL_PALETTE;
  return [
    buildPanelLine(width, [[
      ` Delete "${state.label}"?`,
      palette.warn,
    ]]),
    buildPanelLine(width, [
      [' y', palette.info],
      ['  confirm delete', palette.dim],
      ['   n / Esc', palette.info],
      ['  cancel', palette.dim],
    ]),
  ];
}
