/**
 * renderShortcutsOverlay, the keyboard shortcuts modal (/shortcuts), drawn
 * like the concept's "keys" screen: up to three columns of key / action
 * pairs, keys bold, actions muted, grouped under ✦ headers, with the
 * always-live search row filtering by key or action. Reflects the live
 * keybindings table (user overrides included). Long keys and actions wrap
 * inside their column; the grid scrolls when it is taller than the modal.
 */

import type { KeybindingsManager } from '../input/keybindings.ts';
import type { OverlayFilter } from '../input/overlay-filter.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  searchRow,
  scrollCountText,
  wrapLines,
  MODAL_MARK_INSET,
  type KitHint,
  type SurfaceCanvas,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawTextBlock } from './surface-kit-extra.ts';

interface ShortcutGroup {
  readonly title: string;
  readonly items: ReadonlyArray<readonly [key: string, action: string]>;
}

/** Keys that are real but are not KeyAction entries (context chords, literal characters). */
const HARDCODED_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['Up / Down', 'Recall input history; Down at bottom focuses the process indicator'],
  ['PageUp / PageDn', 'Scroll by full page'],
  ['Home / End', 'Jump to start / end of line'],
  ['n / N (search)', 'Next / previous match'],
  ['Mouse wheel', 'Scroll the conversation (or the open modal)'],
  ['Enter', 'Submit message (composer empty: open the block-actions menu)'],
  ['Shift+Enter', 'Insert newline'],
  ['@', 'Open file picker'],
  ['/', 'Slash command mode'],
  ['Esc', 'Close overlay / cancel generation / clear prompt (context-dependent)'],
  ['Shift+Tab', 'Cycle permission mode (auto-approve / prompt / manual)'],
  ['F2', 'Open Agents'],
  ['?  or  /help', 'Open the command browser (search & run any command)'],
  // Precedence: a partial path under the cursor claims Tab for completion,
  // otherwise it collapses or expands the nearest block.
  ['Tab', 'Path-complete, else collapse/expand block'],
];

/** Where the views live now (they open as modals over the conversation). */
const VIEW_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['/usage', 'Usage: context, tokens and cost'],
  ['/changes', 'Changes: files, diff, review'],
  ['/notifications', 'Notification history'],
  ['Esc', 'Close the top modal (one level)'],
];

/** Every shortcut group, generated from the live keybindings table where it can be. */
function shortcutGroups(keybindingsManager: KeybindingsManager): ShortcutGroup[] {
  const all = keybindingsManager.getAll();
  const combos = (entry: (typeof all)[number]): string => entry.combos.map((c) => keybindingsManager.formatCombo(c)).join(', ');
  return [
    { title: 'Navigation & editing', items: HARDCODED_ROWS },
    { title: 'Actions', items: all.map((e) => [combos(e), e.description] as const) },
    { title: 'Views', items: VIEW_ROWS },
  ];
}

function filterGroups(groups: readonly ShortcutGroup[], query: string): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups.filter((g) => g.items.length > 0);
  return groups
    .map((g) => ({
      title: g.title,
      items: g.title.toLowerCase().includes(q)
        ? g.items
        : g.items.filter(([key, action]) => key.toLowerCase().includes(q) || action.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
}

/** One drawn row of one column. */
type GridCell =
  | { readonly kind: 'blank' }
  | { readonly kind: 'header'; readonly text: string }
  | { readonly kind: 'pair'; readonly key: string; readonly action: string };

interface Block { readonly cells: GridCell[]; readonly group: string; readonly header: boolean }

function blocksFor(groups: readonly ShortcutGroup[], keyW: number, actionW: number): Block[] {
  const blocks: Block[] = [];
  groups.forEach((g, gi) => {
    blocks.push({ cells: [...(gi > 0 ? [{ kind: 'blank' as const }] : []), { kind: 'header', text: g.title }], group: g.title, header: true });
    for (const [key, action] of g.items) {
      const keys = wrapLines(key, keyW);
      const actions = wrapLines(action, actionW);
      const cells: GridCell[] = [];
      for (let k = 0; k < Math.max(keys.length, actions.length); k++) cells.push({ kind: 'pair', key: keys[k] ?? '', action: actions[k] ?? '' });
      blocks.push({ cells, group: g.title, header: false });
    }
  });
  return blocks;
}

/** Split blocks into `n` balanced columns; a header never ends a column, a continued group repeats its header. */
function columnsFor(blocks: readonly Block[], n: number): GridCell[][] {
  const total = blocks.reduce((sum, b) => sum + b.cells.length, 0);
  const target = Math.ceil(total / n);
  const cols: GridCell[][] = [[]];
  blocks.forEach((block, i) => {
    let col = cols[cols.length - 1]!;
    const next = blocks[i + 1];
    const need = block.cells.length + (block.header && next && !next.header ? next.cells.length : 0);
    if (col.length > 0 && col.length + need > target && cols.length < n) {
      col = [];
      cols.push(col);
      if (!block.header) col.push({ kind: 'header', text: block.group });
    }
    const cells = col.length === 0 ? block.cells.filter((c) => c.kind !== 'blank') : block.cells;
    col.push(...cells);
  });
  return cols;
}

function drawCell(canvas: SurfaceCanvas, x: number, y: number, keyW: number, cell: GridCell): void {
  const t = activeTokens();
  if (cell.kind === 'header') {
    canvas.put(x - MODAL_MARK_INSET, y, '✦', { fg: t.brandEnd });
    canvas.put(x, y, cell.text.toLowerCase(), { fg: t.accent, bold: true });
  } else if (cell.kind === 'pair') {
    canvas.put(x, y, cell.key, { fg: t.text, bold: true });
    canvas.put(x + keyW + 2, y, cell.action, { fg: t.textMuted });
  }
}

const HINTS: readonly KitHint[] = [['↑↓', 'scroll'], ['type', 'to filter']];
const COLUMN_GAP = 4;

/**
 * Render the keyboard shortcuts modal as a SurfaceLayer in screen coordinates.
 * `filter` holds the search row's query; the renderer records how far the
 * grid can scroll in it.
 */
export function renderShortcutsOverlay(
  screenWidth: number,
  screenHeight: number,
  keybindingsManager: KeybindingsManager,
  scrollOffset = 0,
  filter?: OverlayFilter,
): SurfaceLayer {
  const t = activeTokens();
  const query = filter?.query ?? '';
  const f = beginModal(screenWidth, screenHeight, { title: 'Keyboard shortcuts', sub: 'customize with /keybindings', hints: HINTS });
  const all = shortcutGroups(keybindingsManager);
  const groups = filterGroups(all, query);
  const totalPairs = all.reduce((n, g) => n + g.items.length, 0);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  searchRow(f, f.top, query, 'Filter shortcuts', query ? `${shown} of ${totalPairs}` : `${totalPairs} shortcuts`);

  const top = f.top + 2;
  const inner = f.r - f.l + 1;
  if (groups.length === 0) {
    if (filter) filter.maxScroll = 0;
    drawTextBlock(f.canvas, f.l, top, inner, [{ text: `No shortcuts match "${query}".`, style: { fg: t.textMuted } }], f.bottom);
    return finishModal(f);
  }

  const n = inner >= 96 ? 3 : inner >= 60 ? 2 : 1;
  const colW = Math.max(8, Math.floor((inner - COLUMN_GAP * (n - 1)) / n));
  const keyW = Math.max(4, Math.min(16, Math.floor(colW * 0.4)));
  const actionW = Math.max(4, colW - keyW - 2);
  const cols = columnsFor(blocksFor(groups, keyW, actionW), n);
  const gridH = Math.max(...cols.map((c) => c.length));
  const capacity = Math.max(1, f.bottom - top + 1);
  const maxScroll = Math.max(0, gridH - capacity);
  if (filter) filter.maxScroll = maxScroll;
  const offset = Math.max(0, Math.min(scrollOffset, maxScroll));

  cols.forEach((col, c) => {
    const x = f.l + c * (colW + COLUMN_GAP);
    for (let k = 0; k < capacity && offset + k < col.length; k++) drawCell(f.canvas, x, top + k, keyW, col[offset + k]!);
  });
  f.hintRight = scrollCountText(offset, Math.max(0, gridH - offset - capacity));
  return finishModal(f);
}
