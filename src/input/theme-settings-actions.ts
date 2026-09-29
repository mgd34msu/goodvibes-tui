/**
 * theme-settings-actions, the `display.theme` picker opened from settings.
 *
 * Lists 'system' plus every bundled theme (label + the modes it was authored
 * for). Moving the cursor previews the highlighted theme live (palettes
 * rebuild, full repaint); Enter stores it in `display.theme`; Esc restores the
 * theme that was active when the picker opened.
 */

import type { CommandContext } from './command-registry.ts';
import type { SelectionItem } from './selection-modal.ts';
import {
  getActiveThemeName,
  listThemeChoices,
  normalizeThemeName,
  setActiveThemeName,
  type ThemeChoice,
} from '../renderer/theme.ts';
import { THEME_NAME_CONFIG_KEY } from '../renderer/theme-mode-config.ts';
import { getTerminalPalette } from '../renderer/terminal-palette.ts';

function variantText(choice: ThemeChoice): string {
  return choice.variants.length > 1 ? `${choice.variants.join(' + ')}` : `${choice.variants[0] ?? 'dark'} only`;
}

function systemNote(): string {
  const palette = getTerminalPalette();
  const answered = palette !== null
    && (palette.background !== undefined || palette.foreground !== undefined || palette.ansi.some((slot) => slot !== undefined));
  return answered ? 'from your terminal colors' : 'terminal colors not read; shows GoodVibes';
}

/** Build the picker rows (exported for tests). */
export function buildThemePickerItems(current: string): SelectionItem[] {
  return listThemeChoices().map((choice) => {
    const detailParts = [choice.name === 'system' ? systemNote() : variantText(choice)];
    if (choice.name === current) detailParts.push('(current)');
    return {
      id: choice.name,
      label: choice.label,
      detail: detailParts.join('  '),
      category: choice.name === 'system' ? 'follow the terminal' : 'bundled themes',
      primaryAction: 'select',
      actions: '[Enter] use theme  [Esc] keep previous',
    };
  });
}

/** Open the theme picker. Returns false when this runtime has no selection modal. */
export function openThemePicker(ctx: CommandContext): boolean {
  if (!ctx.openSelection) return false;
  const configured = normalizeThemeName(ctx.platform.configManager.get(THEME_NAME_CONFIG_KEY));
  const previous = getActiveThemeName();
  const repaint = (): void => {
    ctx.requestFullRepaint?.();
    ctx.renderRequest();
  };

  ctx.openSelection('Choose Theme', buildThemePickerItems(configured), {
    preSelectId: configured,
    allowSearch: true,
    primaryVerbLabel: 'Use',
    onHighlight: (item) => {
      if (!item || item.id === getActiveThemeName()) return;
      setActiveThemeName(item.id);
      repaint();
    },
  }, (result) => {
    if (!result) {
      if (getActiveThemeName() !== previous) {
        setActiveThemeName(previous);
        repaint();
      }
      return;
    }
    ctx.platform.configManager.setDynamic(THEME_NAME_CONFIG_KEY, result.item.id);
    const applied = setActiveThemeName(result.item.id);
    ctx.print(`Theme set to ${applied}.`);
    repaint();
  });
  return true;
}
