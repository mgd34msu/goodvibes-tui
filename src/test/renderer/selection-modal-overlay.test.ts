import { describe, expect, test } from 'bun:test';
import { renderSelectionModalOverlay } from '../../renderer/selection-modal-overlay.ts';
import { SelectionModal } from '../../input/selection-modal.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { frameFromLayer, frameText, layerText, layerTextBlock } from '../helpers/surface-frame.ts';

describe('renderSelectionModalOverlay (modal surface kit)', () => {
  test('selected row is the gradient row with dark bold text, inset 2 columns from the fill edges; no box frame', () => {
    const modal = new SelectionModal();
    modal.open('Pick Workspace', [
      { id: 'a', label: 'Alpha', detail: 'first workspace', category: 'Recent' },
      { id: 'b', label: 'Bravo', detail: 'second workspace', category: 'Recent' },
      { id: 'c', label: 'Gamma', detail: 'third workspace', category: 'Other' },
    ]);
    modal.selectedIndex = 1;

    const layer = renderSelectionModalOverlay(modal, 84, 24);
    const text = layerTextBlock(layer);
    expect(text).not.toMatch(/[┌┐└┘│─]/);
    expect(text).toMatch(/✦\s*Pick Workspace/);
    // Category headers are lowercase kit group headers.
    expect(text).toMatch(/✦\s*recent/);
    expect(text).toMatch(/✦\s*other/);

    const t = activeTokens();
    const row = layer.lines.find((line) => line.some((cell) => cell.char === 'B' && cell.fg === t.selectedListItemText));
    expect(row).toBeDefined();
    const w = row!.length;
    const tinted = row!.map((cell, x) => (cell.bg !== t.backgroundPanel ? x : -1)).filter((x) => x >= 0);
    expect(tinted[0]).toBe(2);
    expect(tinted[tinted.length - 1]).toBe(w - 3);
    expect(row!.find((cell) => cell.char === 'B')!.bold).toBe(true);
  });

  test('the search row is always live: the typed query shows with the cursor, the placeholder when empty', () => {
    const modal = new SelectionModal();
    modal.open('Pick Workspace', [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo' }], { allowSearch: true });
    expect(layerTextBlock(renderSelectionModalOverlay(modal, 84, 24))).toContain('▏Type to filter');
    modal.setQuery('br');
    const text = layerTextBlock(renderSelectionModalOverlay(modal, 84, 24));
    expect(text).toContain('br▏');
    expect(text).toContain('1 of 2');
  });

  test('keycap hints replace the old [Enter] strings; item actions become keycaps', () => {
    const modal = new SelectionModal();
    modal.open('Sessions', [{ id: 'a', label: 'Alpha', actions: '[d] delete  [r] rename' }], { primaryVerbLabel: 'Run' });
    const text = layerTextBlock(renderSelectionModalOverlay(modal, 100, 24));
    expect(text).not.toContain('[Enter]');
    expect(text).toContain(' ⏎  run');
    expect(text).toContain(' d  delete');
    expect(text).toContain(' r  rename');
  });

  test('wraps the FULL detail text onto follow-on lines when the modal is narrow, never clipping it', () => {
    const modal = new SelectionModal();
    const detail = 'detail text that should wrap instead of clipping away in narrow modal widths';
    modal.open('Pick Workspace', [{ id: 'a', label: 'Alpha Workspace', detail }]);
    const text = layerText(renderSelectionModalOverlay(modal, 44, 18)).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Alpha Workspace');
    expect(text).toContain(detail);
  });

  test('a short question is a small centered dialog that stays inside the screen', () => {
    const modal = new SelectionModal();
    modal.open('Continue?', [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], { allowSearch: false });
    const layer = renderSelectionModalOverlay(modal, 100, 30);
    expect(layer.lines.length).toBeLessThan(15);
    expect(layer.y).toBeGreaterThan(Math.round(30 * 0.08));
    const frame = frameText(frameFromLayer(layer, 100, 30)).join('\n');
    expect(frame).toContain('Yes');
    expect(frame).toContain('No');
  });
});
