/**
 * renderProfilePickerModal, renders the /profiles picker modal as Line[]
 * using ModalFactory.
 *
 * Shows a list of saved profiles with:
 *   - name, timestamp (formatted)
 * Footer hints: [Up/Down] Navigate  [Enter] Load  [d] Arm/Delete  [s] Save current  [Esc] Close
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { ModalFactory } from './modal-factory.ts';
import type { ProfilePickerModal } from '../input/profile-picker-modal.ts';
import { formatTimestamp } from './modal-utils.ts';
import { fitDisplay } from '../utils/terminal-width.ts';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';

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
  viewportHeight = 24,
): Line[] {
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 6,
    minContentRows: 5,
    maxContentRows: 9,
  });
  const boxMargin = metrics.margin;
  const boxW = metrics.boxWidth;
  const contentW = metrics.contentWidth;
  const visibleRows = metrics.contentRows;
  const targetContentRows = getStableOverlayContentRows(metrics.contentRows, 8);
  modal.setVisibleRows(visibleRows);

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
    // Proportional column widths that adapt to the modal's content width:
    // timestamp ~22% (clamped 10..16); the name column absorbs the remainder
    // (ported from session-picker-modal.ts). Reserves 4 cols, 2 for the
    // name/timestamp separator and 2 for the list row's selection indicator
    // ("▸ ") that ModalFactory prepends outside the wrapped label, so the
    // row never spills the timestamp's embedded space onto a wrapped line.
    const tsW = Math.min(16, Math.max(10, Math.floor(contentW * 0.22)));
    const nameW = Math.max(8, contentW - tsW - 4);

    // Column header
    const nameHdr = fitDisplay('Name', nameW);
    const tsHdr   = fitDisplay('Saved', tsW);
    sections.push({
      type: 'text',
      content: `${nameHdr}  ${tsHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const visibleProfiles = modal.profiles.slice(modal.scrollOffset, modal.scrollOffset + visibleRows);
    const listItems: import('./modal-factory.ts').ModalListItem[] = visibleProfiles.map((prof, idx) => {
      const isSelected = modal.scrollOffset + idx === modal.selectedIndex;

      const nameStr = fitDisplay(prof.name, nameW);

      const tsStr = fitDisplay(formatTimestamp(prof.timestamp), tsW);

      const label = `${nameStr}  ${tsStr}`;
      return { label, selected: isSelected };
    });

    sections.push({ type: 'list', items: listItems });
    if (modal.profiles.length > visibleRows) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `[${modal.scrollOffset + 1}-${Math.min(modal.profiles.length, modal.scrollOffset + visibleRows)} of ${modal.profiles.length}]`,
        style: { fg: '244', dim: true },
      });
    }
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
  if (modal.deleteConfirmationTarget) {
    sections.push({
      type: 'text',
      content: `Press [d] again to permanently delete ${modal.deleteConfirmationTarget}.`,
      style: { fg: '#f59e0b', dim: true },
    });
  }

  return ModalFactory.createModal(
    {
      title: 'Profiles',
      width: boxW,
      margin: boxMargin,
      targetContentRows,
      sections,
      hints: ['[Up/Down] Navigate', '[Enter] Load', '[d] Arm/Delete', '[s] Save current', '[Esc] Close'],
    },
    width,
  );
}
