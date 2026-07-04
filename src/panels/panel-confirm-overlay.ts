// ---------------------------------------------------------------------------
// PanelConfirmOverlay — arm a confirm from outside, resolve it inside
// handleInput().
//
// Why this exists: SlashCommand.handler(args, ctx) is a single-shot call —
// there is no "await next keypress" primitive in the command layer. A command
// that needs a destructive confirm (e.g. /rewind — checkpoint-runtime.ts) can
// only resolve its target, open+focus a panel, and arm a pending confirm;
// the actual y/n/Enter/Esc handling has to live in that panel's
// handleInput() loop. This wraps the project's canonical ConfirmState<T>
// contract (confirm-state.ts, used inline by GitPanel) so panels opened this
// way don't each hand-roll the same field + dispatch + render wiring.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';

export interface PanelConfirmOverlayHandlers {
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel?: () => void;
}

export class PanelConfirmOverlay {
  private state: ConfirmState<{ id: string }> | null = null;
  private handlers: PanelConfirmOverlayHandlers | null = null;

  /** @param onChange Called after arm() and after a confirmed/cancelled resolution (not on an absorbed keypress) — wire to the host panel's protected markDirty(). */
  constructor(private readonly onChange: () => void = () => {}) {}

  /** Arm a confirm/cancel prompt. Caller's handlers run only from handleInput(), never eagerly. */
  arm(opts: { id: string; label: string; verb?: string } & PanelConfirmOverlayHandlers): void {
    this.state = { subject: { id: opts.id }, label: opts.label, verb: opts.verb };
    this.handlers = { onConfirm: opts.onConfirm, onCancel: opts.onCancel };
    this.onChange();
  }

  get pending(): boolean {
    return this.state !== null;
  }

  /**
   * Call FIRST, before any other key dispatch. Returns true if the key was
   * consumed by the overlay (confirmed/cancelled/absorbed); false if no
   * confirm is pending (caller should continue normal dispatch).
   */
  handleInput(key: string): boolean {
    const result = handleConfirmInput(this.state, key);
    if (result === 'inactive') return false;
    if (result === 'confirmed') {
      const handlers = this.handlers;
      this.state = null;
      this.handlers = null;
      this.onChange();
      if (handlers) void handlers.onConfirm();
      return true;
    }
    if (result === 'cancelled') {
      const handlers = this.handlers;
      this.state = null;
      this.handlers = null;
      this.onChange();
      handlers?.onCancel?.();
      return true;
    }
    return true; // absorbed
  }

  /** The two-line confirm overlay, or null when nothing is pending. */
  renderLines(width: number): Line[] | null {
    return this.state ? renderConfirmLines(width, this.state) : null;
  }
}
