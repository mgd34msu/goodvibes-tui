/**
 * renderSessionPickerModal — renders the /sessions picker modal as Line[]
 * using ModalFactory.
 *
 * Shows a list of saved sessions with:
 *   - name, timestamp (formatted), message count
 * Footer hints: [Enter] Load  [d] Delete  [Esc] Close
 */

import type { Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SessionPickerModal } from '../input/session-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the session picker modal as Line[] for overlay in the viewport.
 *
 * @param modal  SessionPickerModal state object.
 * @param width  Terminal width.
 */
export function renderSessionPickerModal(
  modal: SessionPickerModal,
  width: number,
): Line[] {
  const boxMargin = 4;
  const maxBoxW = 76;
  const boxW = Math.min(width - boxMargin * 2, maxBoxW);
  const contentW = boxW - 4;

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  if (modal.sessions.length === 0) {
    sections.push({
      type: 'text',
      content: 'No saved sessions.',
      style: { fg: '244', dim: true },
    });
    sections.push({
      type: 'text',
      content: 'Use /save [name] to save the current session.',
      style: { fg: '240', dim: true },
    });
  } else {
    // Column widths: name(24) | timestamp(16) | messages(remaining)
    const nameW = 24;
    const tsW = 16;
    const msgW = Math.max(4, contentW - nameW - tsW - 4); // 4 = separators/spaces

    // Column header
    const nameHdr = 'Name'.padEnd(nameW);
    const tsHdr   = 'Saved'.padEnd(tsW);
    const msgHdr  = 'Msgs'.padEnd(msgW);
    sections.push({
      type: 'text',
      content: `${nameHdr}  ${tsHdr}  ${msgHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const listItems: import('./modal-factory.ts').ModalListItem[] = modal.sessions.map((sess, idx) => {
      const isSelected = idx === modal.selectedIndex;

      const nameStr = sess.name.length > nameW
        ? sess.name.slice(0, nameW - 1) + '\u2026'
        : sess.name.padEnd(nameW);

      const tsStr = formatTimestamp(sess.timestamp).padEnd(tsW);
      const msgStr = String(sess.messageCount).padEnd(msgW);

      const label = `${nameStr}  ${tsStr}  ${msgStr}`;
      return { label, selected: isSelected };
    });

    sections.push({ type: 'list', items: listItems });
  }

  // Status message if present
  if (modal.statusMessage) {
    sections.push({ type: 'separator' });
    sections.push({
      type: 'text',
      content: modal.statusMessage,
      style: { fg: '#00ffcc' },
    });
  }

  return ModalFactory.createModal(
    {
      title: 'Sessions',
      width: boxW,
      margin: boxMargin,
      sections,
      hints: ['[\u2191\u2193] Navigate', '[Enter] Load', '[d] Delete', '[Esc] Close'],
    },
    width,
  );
}
