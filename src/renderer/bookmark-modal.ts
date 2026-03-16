/**
 * renderBookmarkModal — renders the /bookmarks modal as Line[] using ModalFactory.
 *
 * Shows a list of bookmarked blocks with:
 *   - label (block type + excerpt)
 *   - timestamp (human-readable time)
 * Footer hints: [↑↓] Navigate  [Enter] Jump  [o] Open File  [d] Remove  [Esc] Close
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import { BookmarkModal } from '../input/bookmark-modal.ts';
import type { BookmarkEntry } from '../bookmarks/manager.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function entryLabel(entry: BookmarkEntry): string {
  const time = formatTime(entry.timestamp);
  // Pad the key to a consistent width (truncated to 28 chars)
  const keyPart = entry.key.length > 28
    ? entry.key.slice(0, 27) + '\u2026'
    : entry.key.padEnd(28);
  const labelPart = entry.label.length > 30
    ? entry.label.slice(0, 29) + '\u2026'
    : entry.label;
  return `${keyPart}  ${labelPart}  ${time}`;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the bookmark modal as Line[] for overlay in the viewport.
 *
 * @param modal  BookmarkModal state object.
 * @param width  Terminal width.
 */
export function renderBookmarkModal(
  modal: BookmarkModal,
  width: number,
): Line[] {
  const visRows = BookmarkModal.VISIBLE_ROWS;
  const visible = modal.entries.slice(modal.scrollOffset, modal.scrollOffset + visRows);
  const relSelected = Math.max(0, modal.selectedIndex - modal.scrollOffset);

  const items = visible.length === 0
    ? [{ label: 'No bookmarks — use Ctrl+B to bookmark a block', selected: false }]
    : visible.map((entry, i) => ({
        label: entryLabel(entry),
        selected: i === relSelected,
      }));

  // Scroll indicator in title
  const totalStr = modal.entries.length > 0
    ? `${modal.selectedIndex + 1}/${modal.entries.length}`
    : '0';

  return ModalFactory.createModal(
    {
      title: `Bookmarks  ${totalStr}`,
      width: 80,
      sections: [
        {
          type: 'text',
          content: '  Key                            Label                           Time',
          style: { dim: true },
        },
        { type: 'separator' },
        { type: 'list', items },
      ],
      hints: ['\u2191\u2193 Navigate', 'Enter Jump', 'o Open file', 'd Remove', 'Esc Close'],
    },
    width,
  );
}
