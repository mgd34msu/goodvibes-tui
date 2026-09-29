/**
 * kit-audit.ts, the concept audit's layout checks applied to a modal surface
 * kit layer (the checks the design's Measurements table is verified with):
 *
 *   - OFFSCREEN   a layer cell with content falls outside the screen
 *   - PADDING     text inside a filled block sits closer than 2 columns to
 *                 the block's left or right edge
 *   - VPAD        a filled block of 3+ rows has text on its first or last row
 *   - BAR         a ┃ does not run the full height of the block beside it
 *
 * Blocks are found the way the fills were drawn: the modal fill (every row
 * between the caps, full width) and element panels (maximal rectangles of
 * the backgroundElement color). A selected row's gradient, keycaps and chips
 * are small fills of their own and are not blocks.
 */

import type { Cell, Line } from '@pellux/goodvibes-sdk/platform/types';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { activeTokens } from '../../renderer/theme.ts';

export interface KitAuditIssue {
  readonly kind: 'OFFSCREEN' | 'PADDING' | 'VPAD' | 'BAR';
  readonly row: number;
  readonly detail: string;
}

function hasText(cell: Cell | undefined): boolean {
  return !!cell && cell.char !== '' && cell.char !== ' ' && cell.char !== '▄' && cell.char !== '▀' && cell.char !== '┃';
}

interface Rect { x: number; y: number; w: number; h: number; bg: string }

/** Maximal rectangles of `bg`: runs per row, stacked while the run spans match. */
function rectsOf(lines: readonly Line[], bg: string, from: number, to: number): Rect[] {
  const done: Rect[] = [];
  let open: Rect[] = [];
  for (let y = from; y <= to; y++) {
    const runs: Array<[number, number]> = [];
    const row = lines[y] ?? [];
    let x = 0;
    while (x < row.length) {
      if (row[x]!.bg !== bg) { x++; continue; }
      const start = x;
      while (x < row.length && (row[x]!.bg === bg || (row[x]!.char === '' && row[x - 1]?.bg === bg))) x++;
      runs.push([start, x - start]);
    }
    const next: Rect[] = [];
    for (const [rx, rw] of runs) {
      const cont = open.find((r) => r.x === rx && r.w === rw);
      if (cont) { cont.h++; next.push(cont); } else next.push({ x: rx, y, w: rw, h: 1, bg });
    }
    for (const r of open) if (!next.includes(r)) done.push(r);
    open = next;
  }
  return [...done, ...open];
}

export function auditLayer(layer: SurfaceLayer | null, screenW: number, screenH: number): KitAuditIssue[] {
  if (!layer) return [];
  const issues: KitAuditIssue[] = [];
  const t = activeTokens();
  const lines = layer.lines;
  const h = lines.length;
  const w = lines[0]?.length ?? 0;

  // OFFSCREEN: any drawn cell outside the screen.
  lines.forEach((row, r) => row.forEach((cell, c) => {
    const sx = layer.x + c;
    const sy = layer.y + r;
    const drawn = cell.char !== '' || cell.bg !== '' || cell.fg !== '';
    if (drawn && (sx < 0 || sx >= screenW || sy < 0 || sy >= screenH)) {
      issues.push({ kind: 'OFFSCREEN', row: r, detail: `cell at ${sx},${sy}` });
    }
  }));

  // The modal fill: rows 1..h-2 across the full width.
  const fillTop = 1;
  const fillBottom = h - 2;
  if (fillBottom - fillTop + 1 >= 3) {
    if (lines[fillTop]!.some(hasText)) issues.push({ kind: 'VPAD', row: fillTop, detail: 'modal fill: text on its first row' });
    if (lines[fillBottom]!.some(hasText)) issues.push({ kind: 'VPAD', row: fillBottom, detail: 'modal fill: text on its last row' });
  }
  for (let y = fillTop; y <= fillBottom; y++) {
    const row = lines[y]!;
    for (let x = 0; x < w; x++) {
      if (!hasText(row[x])) continue;
      if (x < 2 || x > w - 3) {
        issues.push({ kind: 'PADDING', row: y, detail: `modal fill: text at column ${x} of ${w}: ${row.map((c) => c.char || '').join('').trim().slice(0, 50)}` });
        break;
      }
    }
  }

  // Element panels.
  for (const rect of rectsOf(lines, t.backgroundElement, fillTop, fillBottom)) {
    if (rect.w < 6) continue;
    const textOn = (y: number): boolean => lines[y]!.slice(rect.x, rect.x + rect.w).some((c) => hasText(c) && c.bg === rect.bg);
    if (rect.h >= 3) {
      if (textOn(rect.y)) issues.push({ kind: 'VPAD', row: rect.y, detail: `panel x${rect.x} w${rect.w} h${rect.h}: text on its first row` });
      if (textOn(rect.y + rect.h - 1)) issues.push({ kind: 'VPAD', row: rect.y + rect.h - 1, detail: `panel x${rect.x} w${rect.w} h${rect.h}: text on its last row` });
    }
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const cells = lines[y]!.slice(rect.x, rect.x + rect.w);
      const first = cells.findIndex((c) => hasText(c) && c.bg === rect.bg);
      if (first < 0) continue;
      let last = cells.length - 1;
      while (last >= 0 && !(hasText(cells[last]) && cells[last]!.bg === rect.bg)) last--;
      if (first < 2 || rect.w - 1 - last < 2) {
        issues.push({ kind: 'PADDING', row: y, detail: `panel x${rect.x} w${rect.w}: left ${first} right ${rect.w - 1 - last}` });
      }
    }
    // A ┃ beside a panel must run its full height.
    for (const bx of [rect.x - 1, rect.x + rect.w]) {
      const bars = Array.from({ length: rect.h }, (_, k) => lines[rect.y + k]?.[bx]?.char === '┃');
      if (bars.some(Boolean) && !bars.every(Boolean)) {
        issues.push({ kind: 'BAR', row: rect.y, detail: `bar at x${bx} on ${bars.filter(Boolean).length}/${rect.h} rows` });
      }
    }
  }
  return issues;
}

/** One line per issue, for readable test failures. */
export function formatIssues(name: string, issues: readonly KitAuditIssue[]): string {
  return issues.map((i) => `${name} ${i.kind} row ${i.row}: ${i.detail}`).join('\n');
}
