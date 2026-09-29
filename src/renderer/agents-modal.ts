/**
 * renderAgentsModal, every agent, chain, workflow, hosted session and
 * background process in one list (replaces the Fleet pane and its aliases).
 *
 *   ✦ Agents  3 running · 1 failed · you $0.25 · fleet $0.47             esc
 *
 *   ▏Type / to filter agents                                         6 shown
 *
 *   ✦ running                                  ┌ element panel ─────────────┐
 *   ◐ engineer  Add a maxDelayMs cap  2m · $0.12   engineer
 *   ◐ └ tester  Edit test/retry.test.ts   48s      claude-sonnet · worktree
 *   ✦ finished                                     → Read src/net/retry.ts
 *   ✕ researcher  verify: 2 tests failing          ◐ Edit test/retry.test.ts
 *
 *   ⏎ open full screen   s steer   x stop   n new agent
 *
 * Levels (Esc goes back one, and never interrupts anything): the list, a
 * full-height view of one agent's transcript, the host-an-agent picker, and
 * the best-of-N candidate picker.
 */

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, clipText, scrollCountText, searchRow, wrapLines, type KitHint, type ModalFrame, type SurfaceCanvas, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { panel, type KitPanel } from './surface-kit-parts.ts';
import { drawTextBlock, splitPanes } from './surface-kit-extra.ts';

export type AgentsTone = 'text' | 'muted' | 'faint' | 'brand' | 'success' | 'warning' | 'error';

/** A line of plain text in a tone. */
export interface AgentsText {
  readonly text: string;
  readonly tone: AgentsTone;
  readonly bold?: boolean;
  /** A marker drawn in front (→ ← ◐ …). */
  readonly glyph?: string;
}

/** Content for the right panel or the full view: text, or prebuilt lines (fleet detail, transcripts). */
export type AgentsBlock =
  | { readonly kind: 'text'; readonly lines: readonly AgentsText[] }
  /** Prebuilt lines for a width (the fleet's detail block). */
  | { readonly kind: 'lines'; readonly build: (width: number) => readonly Line[] };

export interface AgentsDetail {
  readonly title: string;
  readonly meta: string;
  /** Drawn from the top. */
  readonly blocks: readonly AgentsBlock[];
  /** The live tail, drawn from the bottom up (newest last). */
  readonly tail: readonly AgentsText[];
}

/** One option in a sub-level picker (host an agent, pick a winner). */
export interface AgentsOption {
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
}

/** What the renderer reads from the modal. */
export interface AgentsModalView {
  readonly level: 'list' | 'full' | 'picker';
  readonly crumbs: readonly string[];
  readonly sub: string;
  readonly hints: readonly KitHint[];
  readonly status: AgentsText | null;
  /** An inline input being typed (steer), or null. */
  readonly input: { readonly label: string; readonly draft: string } | null;
  // list
  readonly filter: { readonly query: string; readonly active: boolean; readonly count: string };
  readonly rows: readonly KitRow[];
  readonly detail: AgentsDetail | null;
  // full
  readonly full: {
    readonly meta: string;
    readonly header: readonly AgentsText[];
    /** The transcript for a body of this width and height (newest at the bottom). */
    readonly body: (width: number, height: number) => readonly Line[];
  } | null;
  // picker
  readonly picker: { readonly intro: string; readonly options: readonly AgentsOption[]; readonly side: readonly AgentsText[] } | null;
  readonly scrollOwner: object;
}

function toneColor(tone: AgentsTone): string {
  const t = activeTokens();
  switch (tone) {
    case 'text': return t.text;
    case 'muted': return t.textMuted;
    case 'faint': return t.textFaint;
    case 'brand': return t.brand;
    case 'success': return t.success;
    case 'warning': return t.warning;
    case 'error': return t.error;
  }
}

/** Copy prebuilt cells onto the canvas; cells on the terminal's own background take `bg`. */
function blitLine(canvas: SurfaceCanvas, x: number, y: number, line: Line, width: number, bg: string): void {
  const row = canvas.lines[y];
  if (!row) return;
  for (let q = 0; q < width && q < line.length; q++) {
    const cell = line[q]!;
    const cx = x + q;
    if (cx < 0 || cx >= canvas.width) continue;
    // Never leave half of a wide glyph at the right edge.
    if (q === width - 1 && cell.char && line[q + 1]?.char === '') {
      row[cx] = { ...cell, char: ' ', bg: cell.bg || bg };
      continue;
    }
    row[cx] = { ...cell, bg: cell.bg || bg };
  }
}

/** Width the prebuilt detail lines are built at before they are wrapped to the panel. */
const DETAIL_BUILD_WIDTH = 400;

/**
 * Wrap one prebuilt cell row to `width`: trailing blanks dropped, breaks at
 * the last space that fits (a hard break only for a word longer than the
 * row), continuation rows indented two past the row's own leading spaces, and
 * a wide glyph never split from its continuation cell. Nothing is cut off.
 */
function wrapCellLine(line: Line, width: number): Line[] {
  let end = line.length;
  while (end > 0 && line[end - 1]!.char === ' ') end--;
  const cells = line.slice(0, end);
  if (cells.length <= width) return [cells];
  let lead = 0;
  while (lead < cells.length && cells[lead]!.char === ' ') lead++;
  const indent = Math.min(lead + 2, Math.floor(width / 3));
  const blank = { ...cells[0]!, char: ' ' };
  const rows: Line[] = [];
  let start = 0;
  let first = true;
  while (start < cells.length) {
    const avail = first ? width : width - indent;
    const prefix: Line = first ? [] : Array.from({ length: indent }, () => ({ ...blank }));
    if (cells.length - start <= avail) {
      rows.push([...prefix, ...cells.slice(start)]);
      break;
    }
    let cut = start + avail;
    let space = -1;
    for (let q = cut; q > start; q--) if (cells[q]?.char === ' ') { space = q; break; }
    if (space > start) cut = space;
    else if (cells[cut]?.char === '') cut--; // keep a wide glyph whole
    rows.push([...prefix, ...cells.slice(start, cut)]);
    start = cut;
    while (start < cells.length && cells[start]!.char === ' ') start++;
    first = false;
  }
  return rows;
}

/** Draw text lines (wrapped) from row y; returns the row after them. */
function drawTexts(canvas: SurfaceCanvas, x: number, y: number, width: number, lines: readonly AgentsText[], maxY: number, bg?: string): number {
  let yy = y;
  for (const line of lines) {
    const indent = line.glyph ? 2 : 0;
    const parts = wrapLines(line.text, Math.max(1, width - indent));
    for (let k = 0; k < parts.length; k++) {
      if (yy > maxY) return yy;
      if (k === 0 && line.glyph) canvas.put(x, yy, line.glyph, { fg: toneColor(line.tone), bg });
      canvas.put(x + indent, yy, parts[k]!, { fg: toneColor(line.tone), bold: line.bold, bg });
      yy++;
    }
  }
  return yy;
}

/** Rows a list of texts takes when wrapped to `width`. */
function textRows(lines: readonly AgentsText[], width: number): number {
  return lines.reduce((n, line) => n + wrapLines(line.text, Math.max(1, width - (line.glyph ? 2 : 0))).length, 0);
}

function drawDetail(canvas: SurfaceCanvas, p: KitPanel, detail: AgentsDetail): void {
  const t = activeTokens();
  const width = p.r - p.l + 1;
  let y = p.top;
  canvas.put(p.l, y, clipText(detail.title, width), { fg: t.text, bold: true, bg: p.bg });
  y++;
  if (detail.meta) y = drawTexts(canvas, p.l, y, width, [{ text: detail.meta, tone: 'faint' }], p.bottom, p.bg);
  y++;
  // The tail keeps its newest rows; the detail above it gets what is left.
  const tailRows = Math.min(textRows(detail.tail, width), Math.max(0, p.bottom - y + 1 - 2));
  const detailBottom = detail.tail.length > 0 ? p.bottom - tailRows - 1 : p.bottom;
  for (const block of detail.blocks) {
    if (y > detailBottom) break;
    if (block.kind === 'text') y = drawTexts(canvas, p.l, y, width, block.lines, detailBottom, p.bg);
    else for (const built of block.build(DETAIL_BUILD_WIDTH)) {
      for (const line of wrapCellLine(built, width)) {
        if (y > detailBottom) break;
        blitLine(canvas, p.l, y, line, width, p.bg);
        y++;
      }
    }
  }
  if (detail.tail.length === 0 || tailRows <= 0) return;
  // Draw the tail into a scratch run of rows, keeping only the last tailRows.
  const wrapped: AgentsText[] = [];
  for (const line of detail.tail) {
    const parts = wrapLines(line.text, Math.max(1, width - (line.glyph ? 2 : 0)));
    parts.forEach((part, k) => wrapped.push({ text: part, tone: line.tone, bold: line.bold, glyph: k === 0 ? line.glyph : line.glyph ? ' ' : undefined }));
  }
  const shown = wrapped.slice(-tailRows);
  let ty = p.bottom - shown.length + 1;
  for (const line of shown) {
    if (line.glyph && line.glyph !== ' ') canvas.put(p.l, ty, line.glyph, { fg: toneColor(line.tone), bg: p.bg });
    canvas.put(p.l + (line.glyph ? 2 : 0), ty, line.text, { fg: toneColor(line.tone), bold: line.bold, bg: p.bg });
    ty++;
  }
}

/** The inline input and the status line, at the bottom of the body. Returns the rows they take. */
function bottomRows(view: AgentsModalView, width: number): number {
  let rows = 0;
  if (view.input) rows += wrapLines(`${view.input.label}${view.input.draft}`, width).length;
  if (view.status) rows += wrapLines(view.status.text, width).length;
  return rows > 0 ? rows + 1 : 0;
}

function drawBottom(f: ModalFrame, view: AgentsModalView): void {
  const t = activeTokens();
  const width = f.r - f.l + 1;
  const rows = bottomRows(view, width);
  if (rows === 0) return;
  let y = f.bottom - rows + 2;
  if (view.input) {
    const parts = wrapLines(`${view.input.label}${view.input.draft}`, width);
    parts.forEach((part, k) => {
      const end = f.canvas.put(f.l, y, part, { fg: t.text });
      if (k === parts.length - 1) f.canvas.put(end, y, '▏', { fg: t.brand });
      y++;
    });
  }
  if (view.status) y = drawTexts(f.canvas, f.l, y, width, [view.status], f.bottom);
}

function drawListLevel(f: ModalFrame, view: AgentsModalView): void {
  const t = activeTokens();
  searchRow(f, f.top, view.filter.query, view.filter.active ? '' : 'Type / to filter agents', view.filter.count);
  const bottom = f.bottom - bottomRows(view, f.r - f.l + 1);
  const top = f.top + 2;
  if (view.rows.length === 0) {
    drawTextBlock(f.canvas, f.l, top, f.r - f.l + 1, [{
      text: view.filter.query
        ? `Nothing matches "${view.filter.query}".`
        : 'Nothing is running. Agents, WRFC chains, workflows, hosted sessions and background processes appear here as they start; n hosts a third-party agent. This list starts empty on each launch; every agent\'s event log stays on disk under .goodvibes/tui/sessions.',
      style: { fg: t.textMuted },
    }], bottom);
    drawBottom(f, view);
    return;
  }
  const split = splitPanes(f.l, f.r, top, bottom, 0.5, 6);
  const result = drawList(f.canvas, { rows: view.rows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1, scrollKey: { owner: view.scrollOwner, name: 'list' } });
  f.hintRight = scrollCountText(result.above, result.below);
  if (view.detail && split.panelH >= 4) {
    const p = panel(f.canvas, split.panelX, split.panelY, split.panelW, split.panelH);
    drawDetail(f.canvas, p, view.detail);
  }
  drawBottom(f, view);
}

function drawFullLevel(f: ModalFrame, view: AgentsModalView): void {
  const full = view.full!;
  const width = f.r - f.l + 1;
  let y = f.top;
  if (full.meta) y = drawTexts(f.canvas, f.l, y, width, [{ text: full.meta, tone: 'faint' }], f.bottom);
  if (full.header.length > 0) y = drawTexts(f.canvas, f.l, y, width, full.header, f.bottom);
  y++;
  const bottom = f.bottom - bottomRows(view, width);
  const height = bottom - y + 1;
  if (height > 0) {
    // The transcript is drawn by the conversation renderer at the width of the
    // fill minus 2 columns per side, so its own bars and fills keep their measurements.
    const bodyWidth = width + 4;
    const lines = full.body(bodyWidth, height);
    const start = Math.max(0, lines.length - height);
    for (let k = start; k < lines.length; k++) blitLine(f.canvas, f.l - 2, y + (k - start), lines[k]!, bodyWidth, activeTokens().backgroundPanel);
  }
  drawBottom(f, view);
}

function drawPickerLevel(f: ModalFrame, view: AgentsModalView): void {
  const t = activeTokens();
  const picker = view.picker!;
  const width = f.r - f.l + 1;
  const y = drawTextBlock(f.canvas, f.l, f.top, width, [{ text: picker.intro, style: { fg: t.textMuted } }], f.bottom) + 1;
  const bottom = f.bottom - bottomRows(view, width);
  const rows: KitRow[] = picker.options.map((option) => ({ label: option.label, desc: option.detail, selected: option.selected }));
  const split = picker.side.length > 0 ? splitPanes(f.l, f.r, y, bottom, 0.5, 6) : null;
  const result = drawList(f.canvas, { rows, top: y, bottom: split ? split.bottom : bottom, x0: f.l, x1: split ? split.x1 : f.r, scrollKey: { owner: view.scrollOwner, name: 'picker' } });
  f.hintRight = scrollCountText(result.above, result.below);
  if (split && split.panelH >= 4) {
    const p = panel(f.canvas, split.panelX, split.panelY, split.panelW, split.panelH);
    drawTexts(f.canvas, p.l, p.top, p.r - p.l + 1, picker.side, p.bottom, p.bg);
  }
  drawBottom(f, view);
}

export function renderAgentsModal(view: AgentsModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, { title: 'Agents', crumbs: view.crumbs, sub: view.sub, hints: view.hints });
  if (view.level === 'full' && view.full) drawFullLevel(f, view);
  else if (view.level === 'picker' && view.picker) drawPickerLevel(f, view);
  else drawListLevel(f, view);
  return finishModal(f);
}
