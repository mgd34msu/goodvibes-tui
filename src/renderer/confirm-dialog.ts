/**
 * renderConfirmDialog, a small centered dialog on the kit surface:
 *
 *   ✦ Delete session?                                     esc
 *
 *   This removes "test" and its 3 messages from this project.
 *   It cannot be undone.
 *
 *                                        Cancel    Delete
 *
 * Content-sized and centered, over the dimmed screen. The confirming button
 * carries the dialog's tone (red for destructive actions); the safe choice is
 * on the left. The chosen button is filled, the other sits on the element fill.
 */

import type { ConfirmView } from '../input/confirm-dialog-types.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, modalInnerWidth, standardModalWidth, wrapLines, type SurfaceLayer } from './surface-kit.ts';
import { buttonWidth } from './surface-kit-parts.ts';

/** Preferred width of a confirm dialog. */
const CONFIRM_WIDTH = 64;

export function renderConfirmDialog(dialog: ConfirmView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const { title, body, confirmLabel, tone } = dialog.options;
  const cancelLabel = dialog.options.cancelLabel ?? 'Cancel';
  const width = Math.min(CONFIRM_WIDTH, standardModalWidth(screenWidth));
  const lines = body.split('\n').flatMap((para) => (para.trim() === '' ? [''] : wrapLines(para, modalInnerWidth(width))));
  // Fill rows: padding, title, blank, body, blank, buttons, empty last row.
  const f = beginModal(screenWidth, screenHeight, { title, width, height: lines.length + 6, center: true });
  let y = f.top;
  for (const line of lines) {
    if (y > f.bottom - 2) break;
    f.canvas.put(f.l, y++, line, { fg: t.textMuted });
  }
  const toneBg = tone === 'danger' ? t.error : tone === 'warning' ? t.warning : t.brand;
  const confirmW = buttonWidth(confirmLabel);
  const cancelW = buttonWidth(cancelLabel);
  const by = f.bottom;
  const confirmX = f.r - confirmW + 1;
  const cancelX = confirmX - 2 - cancelW;
  f.canvas.put(cancelX, by, ` ${cancelLabel} `, dialog.chosen === 0
    ? { fg: t.selectedListItemText, bg: t.textMuted, bold: true }
    : { fg: t.textMuted, bg: t.border });
  f.canvas.put(confirmX, by, ` ${confirmLabel} `, dialog.chosen === 1
    ? { fg: t.selectedListItemText, bg: toneBg, bold: true }
    : { fg: toneBg, bg: t.border, bold: true });
  return finishModal(f);
}
