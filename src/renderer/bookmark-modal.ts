/**
 * renderBookmarkModal, the /bookmarks modal drawn with the modal surface kit.
 *
 * Title with the selected position, the always-live search row (filters by
 * key and label), one kit row per bookmark (label, the block key muted after
 * it, the time right-aligned), a muted scroll count and keycap hints:
 * ↑↓ move · ⏎ jump · o open file · d remove.
 */

import { BookmarkModal } from '../input/bookmark-modal.ts';
import type { BookmarkEntry } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  drawWrapped,
  finishModal,
  searchRow,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { listHeight, modalHeightFor, modalTextWidth } from './surface-kit-extra.ts';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function rowFor(entry: BookmarkEntry, selected: boolean): KitRow {
  return { label: entry.label, desc: entry.key, right: formatTime(entry.timestamp), selected };
}

const HINTS: readonly KitHint[] = [['↑↓', 'move'], ['⏎', 'jump'], ['o', 'open file'], ['d', 'remove']];

/**
 * Render the bookmark modal as a SurfaceLayer in screen coordinates.
 */
export function renderBookmarkModal(
  modal: BookmarkModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer {
  const t = activeTokens();
  const visible = modal.visibleEntries;
  const rows = visible.map((entry, i) => rowFor(entry, i === modal.selectedIndex));
  // Size to every bookmark (not the filtered set) so typing never resizes the modal.
  const width = modalTextWidth(screenWidth, screenHeight);
  const allRows = modal.entries.map((entry) => rowFor(entry, false));
  const body = 2 + Math.max(1, listHeight(allRows, 0, width - 1));
  const height = modalHeightFor(screenWidth, screenHeight, { hints: HINTS }, body);

  const position = visible.length > 0 ? `${Math.min(modal.selectedIndex + 1, visible.length)}/${visible.length}` : '';
  const f = beginModal(screenWidth, screenHeight, { title: 'Bookmarks', sub: position, hints: HINTS, height });
  const total = modal.entries.length;
  const count = modal.query ? `${visible.length} of ${total}` : `${total} saved`;
  searchRow(f, f.top, modal.query, 'Filter bookmarks', count);

  const top = f.top + 2;
  if (rows.length === 0) {
    const message = total === 0
      ? 'No bookmarks yet. Press Ctrl+B on a block to bookmark it.'
      : `No bookmarks match "${modal.query}".`;
    drawWrapped(f.canvas, f.l, top, f.r - f.l + 1, message, { fg: t.textMuted }, f.bottom);
    return finishModal(f);
  }
  const res = drawList(f.canvas, { rows, top, bottom: f.bottom, x0: f.l, x1: f.r });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
