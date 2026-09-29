/**
 * surface-modal-host.ts, a stack of self-contained kit modals.
 *
 * A SurfaceModal owns its keys, its own sub-levels and its rendering (drawn
 * with the surface kit). The host keeps them in a stack on the InputHandler:
 *
 *   - Keys go to the top modal only (focus always belongs to the top modal).
 *   - Esc pops exactly one level: the top modal's own sub-level first
 *     (escape() returns true), otherwise the top modal closes. The next Esc
 *     reaches the modal underneath, then the rest of the Esc chain
 *     (handler-modal-stack.ts: close modal, clear composer, cancel turn).
 *   - Every modal in the stack renders, bottom to top; each one dims what is
 *     underneath it.
 *
 * The command palette and the confirm dialog are SurfaceModals; any new modal
 * can be one without touching the handler plumbing again.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';

export type SurfaceModalCloseReason = 'escape' | 'done' | 'cleared';

export interface SurfaceModal {
  /** A short identifier (tests, diagnostics). */
  readonly name: string;
  /** Handle a key or text token while this modal is on top. */
  handleToken(token: InputToken, host: SurfaceModalHost): void;
  /** Esc: pop one of this modal's own sub-levels and return true, or return false to close the modal. */
  escape?(): boolean;
  /** Draw the modal for a screen of the given size. */
  render(screenWidth: number, screenHeight: number): SurfaceLayer;
  /** Called once when the modal leaves the stack. */
  onClose?(reason: SurfaceModalCloseReason): void;
}

export class SurfaceModalHost {
  private readonly stack: SurfaceModal[] = [];

  /** Called after the stack changes (wired to the render request). */
  onChange: (() => void) | null = null;

  get active(): boolean {
    return this.stack.length > 0;
  }

  get depth(): number {
    return this.stack.length;
  }

  top(): SurfaceModal | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** The open modals, bottom first. */
  modals(): readonly SurfaceModal[] {
    return this.stack;
  }

  /** Open a modal on top of whatever is open. Opening one already in the stack moves it to the top. */
  push(modal: SurfaceModal): void {
    const existing = this.stack.indexOf(modal);
    if (existing >= 0) this.stack.splice(existing, 1);
    this.stack.push(modal);
    this.onChange?.();
  }

  /** Remove a modal (usually the top one closing itself after acting). */
  close(modal: SurfaceModal, reason: SurfaceModalCloseReason = 'done'): void {
    const index = this.stack.indexOf(modal);
    if (index < 0) return;
    this.stack.splice(index, 1);
    modal.onClose?.(reason);
    this.onChange?.();
  }

  /** Esc: one level. Returns false when nothing was open. */
  escape(): boolean {
    const top = this.top();
    if (!top) return false;
    if (top.escape?.() === true) {
      this.onChange?.();
      return true;
    }
    this.close(top, 'escape');
    return true;
  }

  /** Route a token to the top modal. Returns false when nothing was open. */
  handleToken(token: InputToken): boolean {
    const top = this.top();
    if (!top) return false;
    top.handleToken(token, this);
    return true;
  }

  /** Close everything (e.g. when the whole modal stack is cleared). */
  clear(): void {
    while (this.stack.length > 0) {
      const modal = this.stack.pop()!;
      modal.onClose?.('cleared');
    }
    this.onChange?.();
  }

  /** Layers for the compositor, bottom first. */
  render(screenWidth: number, screenHeight: number): SurfaceLayer[] {
    return this.stack.map((modal) => modal.render(screenWidth, screenHeight));
  }
}
