/**
 * confirm-dialog.ts, a small centered yes/no dialog on the kit surface.
 *
 * The safe choice sits on the left and is chosen by default for destructive
 * and warning dialogs; the confirming button carries its tone (a red chip for
 * destructive actions). Arrows or tab move between the buttons, Enter presses
 * the chosen one, y and n answer directly, Esc cancels.
 */

import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from './surface-modal-host.ts';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import { renderConfirmDialog } from '../renderer/confirm-dialog.ts';
import type { ConfirmOptions, ConfirmView } from './confirm-dialog-types.ts';
export type { ConfirmOptions, ConfirmTone } from './confirm-dialog-types.ts';

export class ConfirmDialog implements SurfaceModal, ConfirmView {
  readonly name = 'confirm';
  /** 0 = cancel (left), 1 = confirm (right). */
  chosen: 0 | 1;
  private answered = false;

  constructor(
    readonly options: ConfirmOptions,
    private readonly onResult: (confirmed: boolean) => void,
  ) {
    this.chosen = options.tone === 'danger' || options.tone === 'warning' ? 0 : 1;
  }

  private answer(host: SurfaceModalHost, confirmed: boolean): void {
    this.answered = true;
    host.close(this, 'done');
    this.onResult(confirmed);
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    if (token.type === 'text') {
      const ch = token.value.toLowerCase();
      if (ch === 'y') this.answer(host, true);
      else if (ch === 'n') this.answer(host, false);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    if (key === 'left' || key === 'right' || key === 'tab') this.chosen = this.chosen === 0 ? 1 : 0;
    else if (key === 'enter') this.answer(host, this.chosen === 1);
    else if (key === 'y') this.answer(host, true);
    else if (key === 'n') this.answer(host, false);
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    // Esc or a cleared stack is a "no": the safe answer to an unanswered question.
    if (!this.answered) {
      this.answered = true;
      this.onResult(false);
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderConfirmDialog(this, screenWidth, screenHeight);
  }
}

/** Ask through a host; resolves true only when the confirming button was pressed. */
export function confirmThrough(host: SurfaceModalHost, options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => host.push(new ConfirmDialog(options, resolve)));
}
