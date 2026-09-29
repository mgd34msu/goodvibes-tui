/**
 * renderProfilePickerModal, the /profiles picker drawn with the modal surface
 * kit: the always-live search row (filters by name), one kit row per saved
 * profile (name, saved time right-aligned), an armed delete shown in the
 * error color with its "press d again" prompt, the status line, and keycap
 * hints: ↑↓ move · ⏎ load · d delete · s save current.
 */

import type { ProfilePickerModal } from '../input/profile-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock, listHeight, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

const HINTS: readonly KitHint[] = [['↑↓', 'move'], ['⏎', 'load'], ['d', 'delete'], ['s', 'save current']];

/**
 * Render the profile picker modal as a SurfaceLayer in screen coordinates.
 */
export function renderProfilePickerModal(
  modal: ProfilePickerModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer {
  const t = activeTokens();
  const visible = modal.visibleProfiles;
  const armed = modal.deleteConfirmationTarget;
  const rows: KitRow[] = visible.map((profile, i) => ({
    label: profile.name,
    right: formatTimestamp(profile.timestamp),
    selected: i === modal.selectedIndex,
    danger: armed === profile.name,
    mark: armed === profile.name ? '✕' : undefined,
    markFg: t.error,
  }));

  const notes: TextLine[] = [];
  if (armed) notes.push({ text: `Press d again to permanently delete ${armed}.`, style: { fg: t.warning, bold: true } });
  else if (modal.statusMessage) notes.push({ text: modal.statusMessage, style: { fg: t.accent } });

  const width = modalTextWidth(screenWidth, screenHeight);
  const allRows = modal.profiles.map((profile): KitRow => ({ label: profile.name, right: formatTimestamp(profile.timestamp) }));
  const emptyLines: TextLine[] = [
    { text: 'No saved profiles.', style: { fg: t.textMuted } },
    { text: 'Press s to save the current settings as a profile.', style: { fg: t.textFaint } },
  ];
  const listRows = allRows.length > 0 ? listHeight(allRows, 0, width - 1) : textBlockHeight(emptyLines, width);
  const noteRows = notes.length > 0 ? textBlockHeight(notes, width) + 1 : 0;
  const height = modalHeightFor(screenWidth, screenHeight, { hints: HINTS }, 2 + listRows + noteRows);

  const f = beginModal(screenWidth, screenHeight, { title: 'Profiles', hints: HINTS, height });
  const total = modal.profiles.length;
  searchRow(f, f.top, modal.query, 'Filter profiles', modal.query ? `${visible.length} of ${total}` : `${total} saved`);

  const top = f.top + 2;
  const listBottom = f.bottom - noteRows;
  if (notes.length > 0) drawTextBlock(f.canvas, f.l, listBottom + 2, f.r - f.l + 1, notes, f.bottom);

  if (total === 0) {
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, emptyLines, listBottom);
  } else if (rows.length === 0) {
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{ text: `No profiles match "${modal.query}".`, style: { fg: t.textMuted } }], listBottom);
  } else {
    const res = drawList(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r });
    f.hintRight = scrollCountText(res.above, res.below);
  }
  return finishModal(f);
}
