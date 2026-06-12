// ---------------------------------------------------------------------------
// useConfirmState<T> — reusable inline confirm/cancel helper
//
// ── Project-standard confirm contract (all panels must match) ──────────────
//
// CONFIRM:  Enter, Return, or y
// CANCEL:   Esc or n
// ABSORBED: any other key while confirm is active (keeps confirm pending)
//
// Implementation:
//   - Composable: any panel holds a ConfirmState<T> field; no new base class
//   - Call handleConfirmInput(confirm, key) BEFORE normal key dispatch.
//     It handles all four outcomes and returns one of the four result tokens.
//   - Call renderConfirmLines(width, state) to render the two-line overlay
//     that replaces normal content while a confirm is pending.
//
// ── This file is the canonical contract for all confirm flows ─────────────
// Any new panel confirm flow must use ConfirmState<T> and handleConfirmInput;
// do not implement a bespoke two-press or Enter-only variant.
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
 * Project-standard confirm contract:
 *   - CONFIRM:  Enter, Return, or y
 *   - CANCEL:   Esc or n
 *   - ABSORBED: any other key while confirm is active (keeps confirm pending)
 *
 * Returns:
 *   - `'confirmed'` — user pressed Enter, Return, or y; caller must execute
 *     the action and clear state (set confirm to null)
 *   - `'cancelled'` — user pressed n or Esc; caller must clear state
 *   - `'absorbed'`  — any other key while confirm is active; caller returns true
 *   - `'inactive'`  — no confirm pending; caller continues normal dispatch
 */
export function handleConfirmInput<T = string>(
  confirm: ConfirmState<T> | null,
  key: string,
): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
  if (!confirm) return 'inactive';
  if (key === 'y' || key === 'enter' || key === 'return') return 'confirmed';
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
      [' Enter / y', palette.info],
      ['  confirm', palette.dim],
      ['   n / Esc', palette.info],
      ['  cancel', palette.dim],
    ]),
  ];
}
