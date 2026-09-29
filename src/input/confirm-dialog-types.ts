/**
 * confirm-dialog-types.ts, the shapes the confirm dialog and its renderer
 * share (kept apart so the renderer never imports the modal it draws).
 */

export type ConfirmTone = 'danger' | 'warning' | 'primary';

export interface ConfirmOptions {
  readonly title: string;
  /** Wrapped in full; paragraphs split on '\n'. */
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** danger: a red confirm chip; warning: amber; primary: the brand color. Default primary. */
  readonly tone?: ConfirmTone;
  /**
   * A key chord that, pressed again while the dialog is open, confirms (the
   * chord that opened it: ctrl+x twice stops an agent). Enter and y still work.
   */
  readonly confirmChord?: { readonly key: string; readonly ctrl?: boolean };
}

/** What the confirm renderer reads from the dialog. */
export interface ConfirmView {
  readonly options: ConfirmOptions;
  /** 0 = cancel (left), 1 = confirm (right). */
  readonly chosen: 0 | 1;
}
