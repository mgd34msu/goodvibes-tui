import { describe, expect, test } from 'bun:test';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { DEFAULT_OVERLAY_PALETTE } from '../../renderer/overlay-box.ts';
import { SelectionModal } from '../../input/selection-modal.ts';

describe('renderSelectionModalOverlay', () => {
  test('keeps selected-row highlight inside intact borders', () => {
    const modal = new SelectionModal();
    modal.open('Pick Workspace', [
      { id: 'a', label: 'Alpha', detail: 'first workspace', category: 'Recent' },
      { id: 'b', label: 'Bravo', detail: 'second workspace', category: 'Recent' },
      { id: 'c', label: 'Gamma', detail: 'third workspace', category: 'Other' },
    ]);
    modal.selectedIndex = 1;

    const width = 84;
    const lines = renderSelectionModalOverlay(modal, width);

    for (const line of lines) {
      expect(line.length).toBe(width);
    }

    const boxMargin = lines[0]?.findIndex((cell) => cell.char === '┌') ?? -1;
    const rightX = lines[0]?.findLastIndex((cell) => cell.char === '┐') ?? -1;

    expect(lines[0]?.[boxMargin]?.char).toBe('┌');
    expect(lines[0]?.[rightX]?.char).toBe('┐');
    expect(lines.at(-1)?.[boxMargin]?.char).toBe('└');
    expect(lines.at(-1)?.[rightX]?.char).toBe('┘');

    const selectedRow = lines.find((line) =>
      line.some((cell) => cell.bg === DEFAULT_OVERLAY_PALETTE.selectedBg && cell.char.trim().length > 0)
    );
    expect(selectedRow).toBeDefined();
    expect(selectedRow?.[boxMargin]?.char).toBe('│');
    expect(selectedRow?.[boxMargin]?.bg).toBe('');
    expect(selectedRow?.[rightX]?.char).toBe('│');
    expect(selectedRow?.[rightX]?.bg).toBe('');
    expect(selectedRow?.[boxMargin + 1]?.bg).toBe(DEFAULT_OVERLAY_PALETTE.selectedBg);
    expect(selectedRow?.[rightX - 1]?.bg).toBe(DEFAULT_OVERLAY_PALETTE.selectedBg);
  });

  test('shows a block cursor only when search is focused', () => {
    const modal = new SelectionModal();
    modal.open('Pick Workspace', [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Bravo' },
    ], { allowSearch: true });
    modal.searchFocused = false;

    const unfocused = renderSelectionModalOverlay(modal, 84).map(line => line.map(cell => cell.char).join('')).join('\n');
    expect(unfocused).not.toContain('█');

    modal.searchFocused = true;
    const focused = renderSelectionModalOverlay(modal, 84).map(line => line.map(cell => cell.char).join('')).join('\n');
    expect(focused).toContain('█');
  });

  test('wraps detail text onto a follow-on line when the modal is narrow', () => {
    const modal = new SelectionModal();
    modal.open('Pick Workspace', [
      { id: 'a', label: 'Alpha Workspace', detail: 'detail text that should wrap instead of clipping away in narrow modal widths' },
    ]);
    const text = renderSelectionModalOverlay(modal, 44, 18).map(line => line.map(cell => cell.char).join('')).join('\n');
    expect(text).toContain('Alpha Workspace');
    expect(text).toContain('detail text');
  });
});
