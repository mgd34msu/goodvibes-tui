/**
 * renderCommandPalette, the command palette drawn with the surface kit.
 *
 *   ✦ Commands                                                     esc
 *
 *   ▏Type a command, setting, model or session          156 commands
 *
 *   ✦ suggested                                ┌ preview ────────────┐
 *     Changes                        /diff      Changes
 *     Switch model  opus 5.5        /model      /diff [path]
 *   ✦ session                                   Show the working-tree
 *     Resume a session             /resume      diff. …
 *
 *   ↑↓ move   ⏎ run   tab fill composer                   120 more ↓
 *
 * The preview pane shows what the selected command will do before it runs:
 * its full description, usage, aliases, category and what Enter will do.
 */

import type { PaletteEntry, PaletteView } from '../input/command-palette-types.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, searchRow, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { panel, panelLines, type KitPanel } from './surface-kit-parts.ts';

function rowsFor(palette: PaletteView): KitRow[] {
  const selected = palette.getSelected();
  const rows: KitRow[] = [];
  const searching = palette.query.trim().length > 0;
  for (const section of palette.sections()) {
    if (!searching) rows.push({ header: section.group });
    for (const entry of section.entries) {
      rows.push({
        label: entry.title,
        desc: palette.describe(entry.id),
        right: entry.right ?? `/${entry.id}`,
        selected: entry === selected,
      });
    }
  }
  if (rows.length === 0) rows.push({ label: `Nothing matches "${palette.query}".`, muted: true });
  return rows;
}

function drawPreview(palette: PaletteView, entry: PaletteEntry | null, canvas: Parameters<typeof panelLines>[0], p: KitPanel): void {
  const t = activeTokens();
  if (!entry) {
    panelLines(canvas, p, p.l, p.top, [{ text: 'Type to search every command; old pane names such as fleet or git find their new homes.', style: { fg: t.textMuted } }]);
    return;
  }
  const blank = { text: '', style: {} };
  const live = palette.describe(entry.id);
  panelLines(canvas, p, p.l, p.top, [
    { text: entry.title, style: { fg: t.text, bold: true } },
    { text: `/${entry.id}${entry.argsHint ? ` ${entry.argsHint}` : ''}`, style: { fg: t.brand } },
    ...(live ? [{ text: live, style: { fg: t.textMuted } }] : []),
    blank,
    ...(entry.description ? [{ text: entry.description, style: { fg: t.textMuted } }, blank] : []),
    {
      text: entry.needsArgs
        ? `Enter fills the composer: it needs ${entry.argsHint ?? 'arguments'}.`
        : 'Enter runs it now; tab fills the composer to add arguments.',
      style: { fg: t.textFaint },
    },
    blank,
    ...(entry.aliases.length > 0 ? [{ text: `Also: ${entry.aliases.map((a) => `/${a}`).join('  ')}`, style: { fg: t.textFaint } }] : []),
    ...(entry.keywords.length > 0 ? [{ text: `Finds: ${entry.keywords.join(', ')}`, style: { fg: t.textFaint } }] : []),
    { text: entry.category, style: { fg: t.textFaint } },
  ]);
}

export function renderCommandPalette(palette: PaletteView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Commands',
    hints: [['↑↓', 'move'], ['⏎', 'run'], ['tab', 'fill composer']],
  });
  const total = palette.entries.length;
  const shown = palette.flat().length;
  searchRow(f, f.top, palette.query, 'Type a command, setting, model or session', palette.query ? `${shown} of ${total}` : `${total} commands`);

  const body = f.top + 2;
  const inner = f.r - f.l + 1;
  // A preview pane when there is room for it; below that the list takes the width.
  const twoPane = inner >= 70;
  const x1 = twoPane ? f.l + Math.floor(inner * 0.55) - 1 : f.r;
  const result = drawList(f.canvas, { rows: rowsFor(palette), top: body, bottom: f.bottom, x0: f.l, x1, scrollKey: { owner: palette, name: 'list' } });
  if (twoPane) {
    const p = panel(f.canvas, x1 + 3, body, f.r + 2 - (x1 + 3) + 1, f.bottom - body + 1);
    drawPreview(palette, palette.getSelected(), f.canvas, p);
  }
  f.hintRight = scrollCountText(result.above, result.below);
  return finishModal(f);
}
