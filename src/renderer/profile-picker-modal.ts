/**
 * renderProfilePickerModal — renders the /profiles picker modal as Line[]
 * using ModalFactory.
 *
 * Shows a list of saved profiles with:
 *   - name, timestamp (formatted), settings preview
 * Footer hints: [↑↓] Navigate  [Enter] Load  [d] Delete  [s] Save current  [Esc] Close
 */

import type { Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { ProfilePickerModal } from '../input/profile-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the profile picker modal as Line[] for overlay in the viewport.
 *
 * @param modal  ProfilePickerModal state object.
 * @param width  Terminal width.
 */
export function renderProfilePickerModal(
  modal: ProfilePickerModal,
  width: number,
): Line[] {
  const boxMargin = 4;
  const maxBoxW = 76;
  const boxW = Math.min(width - boxMargin * 2, maxBoxW);
  const contentW = boxW - 4;

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  if (modal.profiles.length === 0) {
    sections.push({
      type: 'text',
      content: 'No saved profiles.',
      style: { fg: '244', dim: true },
    });
    sections.push({
      type: 'text',
      content: 'Press [s] to save the current settings as a profile.',
      style: { fg: '240', dim: true },
    });
  } else {
    // Column widths: name(24) | timestamp(16) | preview(remaining)
    const nameW = 24;
    const tsW = 16;
    const previewW = Math.max(4, contentW - nameW - tsW - 4);

    // Column header
    const nameHdr    = 'Name'.padEnd(nameW);
    const tsHdr      = 'Saved'.padEnd(tsW);
    const previewHdr = 'Settings'.padEnd(previewW);
    sections.push({
      type: 'text',
      content: `${nameHdr}  ${tsHdr}  ${previewHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const listItems: import('./modal-factory.ts').ModalListItem[] = modal.profiles.map((prof, idx) => {
      const isSelected = idx === modal.selectedIndex;

      const nameStr = prof.name.length > nameW
        ? prof.name.slice(0, nameW - 1) + '\u2026'
        : prof.name.padEnd(nameW);

      const tsStr = formatTimestamp(prof.timestamp).padEnd(tsW);

      // Read the profile file to get a preview of settings
      // (We only have name/timestamp in ProfileInfo, so show a placeholder)
      const preview = '(display/provider/behavior)'.padEnd(previewW);

      const label = `${nameStr}  ${tsStr}  ${preview}`;
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
      title: 'Profiles',
      width: boxW,
      margin: boxMargin,
      sections,
      hints: ['[\u2191\u2193] Navigate', '[Enter] Load', '[d] Delete', '[s] Save current', '[Esc] Close'],
    },
    width,
  );
}
