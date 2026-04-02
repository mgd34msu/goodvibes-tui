/**
 * renderSettingsModal — renders the /settings config browser modal as Line[]
 * using ModalFactory.
 *
 * Layout:
 *   - Title bar: ┌─ Settings ───────────────────────────────────────┐
 *   - Category tabs row
 *   - Separator
 *   - Settings list (current category)
 *   - Footer hints: [Tab] Category  [↑↓] Navigate  [Enter] Edit/Toggle  [Esc] Close
 */

import type { Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SettingsModal, SettingEntry, FlagEntry } from '../input/settings-modal.ts';
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

function flagStateColor(state: string, killed: boolean): string {
  if (killed) return '#ef4444'; // red
  if (state === 'enabled') return '#00ffcc'; // cyan-green
  return '244'; // dim
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

  // ── Category tabs ────────────────────────────────────────────
  const tabParts = SETTINGS_CATEGORIES.map((cat, i) => {
    const isActive = i === modal.categoryIndex;
    return isActive ? `[${cat.toUpperCase()}]` : ` ${cat} `;
  });
  const tabLine = tabParts.join(' ');
  const isDangerTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'danger';
  const isFlagsTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'flags';
  sections.push({
    type: 'text',
    content: tabLine,
    style: { fg: isDangerTab ? '#ef4444' : isFlagsTab ? '#a78bfa' : '#00ffff', bold: true },
  });

  sections.push({ type: 'separator' });

  // ── Flags tab ──────────────────────────────────────────────────
  if (isFlagsTab) {
    const flagEntries: FlagEntry[] = modal.flagEntries;

    if (flagEntries.length === 0) {
      sections.push({
        type: 'text',
        content: '(no feature flags registered)',
        style: { fg: '240', dim: true },
      });
    } else {
      // Column widths for flags table
      const nameW = Math.floor(contentW * 0.30);
      const tierW = 5;
      const stateW = 10;
      const notesW = Math.max(0, contentW - nameW - tierW - stateW - 6);

      // Column header
      const nameHdr = 'Name'.padEnd(nameW);
      const tierHdr = 'Tier'.padEnd(tierW);
      const stateHdr = 'State'.padEnd(stateW);
      const notesHdr = 'Notes';
      sections.push({
        type: 'text',
        content: `${nameHdr}  ${tierHdr}  ${stateHdr}  ${notesHdr}`,
        style: { fg: '240', dim: true },
      });
      sections.push({ type: 'separator' });

      const listItems: import('./modal-factory.ts').ModalListItem[] = flagEntries.map((entry, idx) => {
        const isSelected = idx === modal.selectedIndex;
        const isKilled = entry.state === 'killed';

        const nameStr = entry.flag.name.length > nameW
          ? entry.flag.name.slice(0, nameW - 1) + '\u2026'
          : entry.flag.name.padEnd(nameW);
        const tierStr = String(entry.flag.tier).padEnd(tierW);

        let stateStr: string;
        if (isKilled) {
          stateStr = 'KILLED'.padEnd(stateW);
        } else {
          stateStr = entry.state.padEnd(stateW);
        }

        const notes = !entry.flag.runtimeToggleable && !isKilled ? '(restart required)' : '';
        const notesStr = notes.length > notesW ? notes.slice(0, notesW - 1) + '\u2026' : notes;

        const label = `${nameStr}  ${tierStr}  ${stateStr}  ${notesStr}`;

        return {
          label,
          selected: isSelected,
          style: isSelected ? undefined : { fg: flagStateColor(entry.state, isKilled) },
        };
      });

      sections.push({ type: 'list', items: listItems });

      // Description of selected flag
      const selected = modal.getSelectedFlag();
      if (selected) {
        sections.push({ type: 'separator' });
        const desc = selected.flag.description;
        const truncated = desc.length > contentW
          ? desc.slice(0, contentW - 1) + '\u2026'
          : desc;
        sections.push({
          type: 'text',
          content: truncated,
          style: { fg: '246', dim: true },
        });
        if (selected.state === 'killed' && selected.flag.killReason) {
          const killStr = `Kill reason: ${selected.flag.killReason}`;
          const killTrunc = killStr.length > contentW ? killStr.slice(0, contentW - 1) + '\u2026' : killStr;
          sections.push({
            type: 'text',
            content: killTrunc,
            style: { fg: '#ef4444', dim: true },
          });
        }
      }
    }

    const hints = ['[Tab] Category', '[\u2191\u2193] Navigate', '[Enter] Toggle', '[Esc] Close'];
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

  // ── Settings list ────────────────────────────────────────────
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
        ? modal.editBuffer + '\u2588'
        : formatValue(entry);

      const shortKey = entry.setting.key.replace(/^[^.]+\./, ''); // strip category prefix
      const keyStr = shortKey.length > keyW
        ? shortKey.slice(0, keyW - 1) + '\u2026'
        : shortKey.padEnd(keyW);

      const valStr = valueStr.length > valW
        ? valueStr.slice(0, valW - 1) + '\u2026'
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
        ? desc.slice(0, contentW - 1) + '\u2026'
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
          ? optStr.slice(0, contentW - 1) + '\u2026'
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
