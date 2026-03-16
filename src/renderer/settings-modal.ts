/**
 * renderSettingsModal — renders the /settings config browser modal as Line[]
 * using ModalFactory.
 *
 * Layout:
 *   - Title bar: ┌─ Settings ─────────────────────────────────────┐
 *   - Category tabs row
 *   - Separator
 *   - Settings list (current category)
 *   - Footer hints: [Tab] Category  [↑↓] Navigate  [Enter] Edit/Toggle  [Esc] Close
 */

import type { Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SettingsModal, SettingEntry } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(entry: SettingEntry): string {
  const val = entry.currentValue;
  if (val === null || val === undefined) return '(unset)';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string' && val === '') return '(empty)';
  return String(val);
}

function valueColor(entry: SettingEntry): string {
  if (!entry.isDefault) return '#00ffcc'; // cyan-green = modified
  return '244';                            // dim = default
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the settings modal as Line[] for overlay in the viewport.
 *
 * @param modal  SettingsModal state object.
 * @param width  Terminal width.
 */
export function renderSettingsModal(
  modal: SettingsModal,
  width: number,
): Line[] {
  const boxMargin = 4;
  const maxBoxW = 76;
  const boxW = Math.min(width - boxMargin * 2, maxBoxW);
  const contentW = boxW - 4;

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  // ── Category tabs ────────────────────────────────────────────────────────
  const tabParts = SETTINGS_CATEGORIES.map((cat, i) => {
    const isActive = i === modal.categoryIndex;
    return isActive ? `[${cat.toUpperCase()}]` : ` ${cat} `;
  });
  const tabLine = tabParts.join('  ');
  const isDangerTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'danger';
  sections.push({
    type: 'text',
    content: tabLine,
    style: { fg: isDangerTab ? '#ef4444' : '#00ffff', bold: true },
  });

  sections.push({ type: 'separator' });

  // ── Settings list ────────────────────────────────────────────────────────
  const items = modal.currentItems;

  if (items.length === 0) {
    sections.push({
      type: 'text',
      content: '(no settings in this category)',
      style: { fg: '240', dim: true },
    });
  } else {
    const keyW = Math.floor(contentW * 0.45);
    const valW = Math.floor(contentW * 0.22);

    // Column header
    const keyHdr = 'Setting'.padEnd(keyW);
    const valHdr = 'Value'.padEnd(valW);
    const defHdr = 'Default';
    sections.push({
      type: 'text',
      content: `${keyHdr}  ${valHdr}  ${defHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const isDangerCategory = modal.currentCategory === 'danger';
    const listItems: import('./modal-factory.ts').ModalListItem[] = items.map((entry, idx) => {
      const isSelected = idx === modal.selectedIndex;

      // If this is selected and editing, show edit buffer
      const isEditing = isSelected && modal.editingMode;
      const valueStr = isEditing
        ? modal.editBuffer + '█'
        : formatValue(entry);

      const shortKey = entry.setting.key.replace(/^[^.]+\./, ''); // strip category prefix
      const keyStr = shortKey.length > keyW
        ? shortKey.slice(0, keyW - 1) + '…'
        : shortKey.padEnd(keyW);

      const valStr = valueStr.length > valW
        ? valueStr.slice(0, valW - 1) + '…'
        : valueStr.padEnd(valW);

      const defStr = String(entry.setting.default);

      const label = `${keyStr}  ${valStr}  ${defStr}`;

      return {
        label,
        selected: isSelected,
        style: isSelected ? undefined : { fg: isDangerCategory ? '#ef4444' : valueColor(entry) },
      };
    });

    sections.push({ type: 'list', items: listItems });

    // Description of selected item
    const selected = modal.getSelected();
    if (selected) {
      sections.push({ type: 'separator' });
      const desc = selected.setting.description;
      const truncated = desc.length > contentW
        ? desc.slice(0, contentW - 1) + '…'
        : desc;
      sections.push({
        type: 'text',
        content: truncated,
        style: { fg: '246', dim: true },
      });
      // Show enum options if applicable
      if (selected.setting.type === 'enum' && selected.setting.enumValues) {
        const opts = selected.setting.enumValues.join(' | ');
        const optStr = `Options: ${opts}`;
        const optTrunc = optStr.length > contentW
          ? optStr.slice(0, contentW - 1) + '…'
          : optStr;
        sections.push({
          type: 'text',
          content: optTrunc,
          style: { fg: '240', dim: true },
        });
      }
    }
  }

  const hints = modal.editingMode
    ? ['[Enter] Confirm', '[Esc] Cancel']
    : ['[Tab] Category', '[\u2191\u2193] Navigate', '[Enter] Toggle/Edit', '[Esc] Close'];

  return ModalFactory.createModal(
    {
      title: 'Settings',
      width: boxW,
      margin: boxMargin,
      sections,
      hints,
    },
    width,
  );
}
