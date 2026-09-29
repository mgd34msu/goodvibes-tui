/**
 * theme-settings-actions.test.ts, the display.theme picker.
 *
 * Covers: the rows (system + every bundled theme, current marked), live
 * preview as the cursor moves (theme + repaint), Enter persisting the choice,
 * Esc restoring the theme active at open, and the SelectionModal highlight
 * hook the preview rides on.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { SelectionModal, type SelectionItem, type SelectionResult } from '../../input/selection-modal.ts';
import { buildThemePickerItems, openThemePicker } from '../../input/theme-settings-actions.ts';
import { getActiveThemeName, listThemeChoices, setActiveThemeName } from '../../renderer/theme.ts';

afterEach(() => setActiveThemeName('goodvibes'));

interface Harness {
  readonly ctx: CommandContext;
  readonly modal: SelectionModal;
  readonly stored: Map<string, unknown>;
  repaints: number;
  resolve(result: SelectionResult | null): void;
}

function harness(configured: unknown): Harness {
  const modal = new SelectionModal();
  const stored = new Map<string, unknown>([['display.theme', configured]]);
  let callback: ((result: SelectionResult | null) => void) | null = null;
  const h: Harness = {
    modal,
    stored,
    repaints: 0,
    resolve: (result) => {
      modal.close();
      callback?.(result);
    },
    ctx: {
      openSelection: (title: string, items: SelectionItem[], opts: Parameters<SelectionModal['open']>[2], cb: (r: SelectionResult | null) => void) => {
        callback = cb;
        modal.open(title, items, opts);
      },
      platform: {
        configManager: {
          get: (key: string) => stored.get(key),
          setDynamic: (key: string, value: unknown) => { stored.set(key, value); },
        },
      },
      requestFullRepaint: () => { h.repaints++; },
      renderRequest: () => {},
      print: () => {},
    } as unknown as CommandContext,
  };
  return h;
}

describe('theme picker rows', () => {
  test('lists system then every bundled theme, marking the current one', () => {
    const items = buildThemePickerItems('nord');
    expect(items.map((item) => item.id)).toEqual(listThemeChoices().map((choice) => choice.name));
    expect(items[0]!.id).toBe('system');
    expect(items.find((item) => item.id === 'nord')!.detail).toContain('(current)');
    expect(items.find((item) => item.id === 'nord')!.detail).toContain('dark only');
    expect(items.find((item) => item.id === 'dracula')!.detail).toContain('dark + light');
  });
});

describe('openThemePicker', () => {
  test('opens on the configured theme (legacy vaporwave lands on goodvibes-neon)', () => {
    const h = harness('vaporwave');
    setActiveThemeName('vaporwave');
    expect(openThemePicker(h.ctx)).toBe(true);
    expect(h.modal.getSelected()?.id).toBe('goodvibes-neon');
  });

  test('moving the cursor previews the highlighted theme and repaints', () => {
    const h = harness('goodvibes');
    openThemePicker(h.ctx);
    expect(getActiveThemeName()).toBe('goodvibes');
    h.modal.moveDown();
    expect(getActiveThemeName()).toBe(h.modal.getSelected()!.id);
    expect(getActiveThemeName()).toBe('goodvibes-neon');
    expect(h.repaints).toBeGreaterThan(0);
    h.modal.moveDown();
    expect(getActiveThemeName()).toBe('catppuccin');
  });

  test('Esc restores the theme that was active when the picker opened', () => {
    const h = harness('dracula');
    setActiveThemeName('dracula');
    openThemePicker(h.ctx);
    h.modal.moveDown();
    h.modal.moveDown();
    expect(getActiveThemeName()).not.toBe('dracula');
    h.resolve(null);
    expect(getActiveThemeName()).toBe('dracula');
    expect(h.stored.get('display.theme')).toBe('dracula');
  });

  test('Enter stores the choice in display.theme and keeps it active', () => {
    const h = harness('goodvibes');
    openThemePicker(h.ctx);
    h.modal.setQuery('gruv');
    const item = h.modal.getSelected()!;
    expect(item.id).toBe('gruvbox');
    expect(getActiveThemeName()).toBe('gruvbox'); // searching previews too
    h.resolve({ item, action: 'select' });
    expect(h.stored.get('display.theme')).toBe('gruvbox');
    expect(getActiveThemeName()).toBe('gruvbox');
  });
});

describe('SelectionModal onHighlight', () => {
  test('fires on open and only when the highlighted row changes', () => {
    const modal = new SelectionModal();
    const seen: Array<string | null> = [];
    modal.open('t', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], {
      onHighlight: (item) => { seen.push(item?.id ?? null); },
    });
    modal.moveDown();
    modal.moveDown(); // wraps back to a
    modal.setQuery('A'); // still a: no event
    expect(seen).toEqual(['a', 'b', 'a']);
    modal.close();
    modal.moveDown();
    expect(seen).toEqual(['a', 'b', 'a']);
  });
});
