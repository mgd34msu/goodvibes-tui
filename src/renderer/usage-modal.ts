/**
 * renderUsageModal, context and cost for this session (replaces the Tokens and
 * Cost panes).
 *
 *   ✦ Usage  this session                                             esc
 *
 *    Overview    Turns    Agents
 *
 *   Context                                          13.2K of 1.0M · 1%
 *   ██──────────────────────────────────────────────┃──────────────────
 *                                         compacts at 80% ┘
 *
 *   Session                                Per turn              last 8
 *   Input              53.0K               ██
 *   ...                                    ■ input  ■ output  ■ cache read
 *
 * Overview carries the context bar (with the configured compaction threshold
 * marked), the session totals, the per-turn bars and the fleet split. Turns is
 * the per-turn table (cache writes included); Agents is the per-agent cost
 * ledger with the plan total. Budget and price entry replace the tab content
 * while they are open.
 */

import { mixHex } from '@pellux/goodvibes-sdk/platform/presentation';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, clipText, scrollCountText, type KitHint, type ModalFrame, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { drawTabRows, drawTextBlock, tabRowCount } from './surface-kit-extra.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import type { UsageAgentEntry, UsageTracker, UsageTurn } from '../runtime/usage-tracker.ts';

export type UsageTab = 'overview' | 'turns' | 'agents';

export const USAGE_TABS: readonly UsageTab[] = ['overview', 'turns', 'agents'];

const TAB_LABELS: Readonly<Record<UsageTab, string>> = { overview: 'Overview', turns: 'Turns', agents: 'Agents' };

/** What the renderer reads from the modal. */
export interface UsageModalView {
  readonly tracker: UsageTracker;
  readonly tab: UsageTab;
  /** Turns hidden at the newest end (0 = showing the latest). */
  readonly turnOffset: number;
  /** Selected agent in the Agents tab. */
  readonly agentIndex: number;
  /** An open budget or price entry, or null. */
  readonly entry: { readonly kind: 'budget' | 'price'; readonly draft: string } | null;
  /** A one-line result of the last action, or null. */
  readonly status: string | null;
}

/** '53.0K', '1.2M'. */
function formatTokenCount(n: number): string {
  return abbreviateCount(Math.max(0, Math.round(n))).replace(/k$/, 'K');
}

/** '$0.246', '<$0.0001', '$0.00'. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function hintsFor(view: UsageModalView): KitHint[] {
  if (view.entry) return [['⏎', 'save'], ['esc', 'cancel']];
  const base: KitHint[] = [['c', 'compact now']];
  if (view.tab === 'agents') base.push(['↑↓', 'select agent']);
  else base.push(['↑↓', 'scroll turns']);
  base.push(['tab', 'next view'], ['b', 'budget'], ['p', 'model price'], ['r', 'refresh']);
  return base;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function drawContext(f: ModalFrame, view: UsageModalView, y: number): number {
  const t = activeTokens();
  const { canvas, l, r } = f;
  const used = view.tracker.contextTokens();
  const window = view.tracker.contextWindow();
  canvas.put(l, y, 'Context', { fg: t.accent, bold: true });
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  const right = window > 0 ? `${formatTokenCount(used)} of ${formatTokenCount(window)} · ${pct}%` : 'context window unknown';
  if (getDisplayWidth(right) < r - l - 9) canvas.right(r, y, right, { fg: t.textMuted });
  if (window <= 0) return y + 2;

  const barY = y + 2;
  const width = r - l + 1;
  const fraction = Math.min(1, used / window);
  const threshold = view.tracker.compactThreshold();
  const filled = used > 0 ? Math.max(1, Math.round(width * fraction)) : 0;
  const hot = threshold > 0 && fraction >= threshold ? t.error : fraction >= 0.65 ? t.warning : null;
  const tick = threshold > 0 ? Math.min(width - 1, Math.round(width * threshold)) : -1;
  for (let q = 0; q < width; q++) {
    if (q === tick) { canvas.put(l + q, barY, '┃', { fg: t.warning }); continue; }
    const on = q < filled;
    const fg = on ? (hot ?? (width > 1 ? mixHex(t.brand, t.brandEnd, q / (width - 1)) : t.brand)) : t.border;
    canvas.put(l + q, barY, on ? '█' : '─', { fg });
  }
  const labelY = barY + 1;
  if (tick >= 0) {
    const label = `compacts at ${Math.round(threshold * 100)}% ┘`;
    const end = l + tick;
    const start = Math.max(l, end - getDisplayWidth(label) + 1);
    canvas.put(start, labelY, clipText(label, end - start + 1), { fg: t.textFaint });
  } else {
    canvas.put(l, labelY, 'auto-compaction is off', { fg: t.textFaint });
  }
  return labelY + 2;
}

function drawSessionTable(f: ModalFrame, view: UsageModalView, x: number, xr: number, y: number, maxY: number): number {
  const t = activeTokens();
  const { canvas } = f;
  const u = view.tracker.totals();
  const cost = view.tracker.sessionCost();
  if (y > maxY) return y;
  canvas.put(x, y, 'Session', { fg: t.accent, bold: true });
  let yy = y + 1;
  const rows: Array<[string, string, boolean, string?]> = [
    ['Input', formatTokenCount(u.input), false],
    ['Output', formatTokenCount(u.output), false],
    ['Cache read', formatTokenCount(u.cacheRead), false],
    ['Cache write', formatTokenCount(u.cacheWrite), false],
    ['Total', formatTokenCount(u.input + u.output + u.cacheRead + u.cacheWrite), false],
    ['Cost', cost.priced ? formatUsd(cost.usd) : 'price unknown', true, view.tracker.overBudget() ? t.error : undefined],
  ];
  for (const [label, value, bold, fg] of rows) {
    if (yy > maxY) return yy;
    canvas.put(x, yy, label, { fg: t.textMuted });
    canvas.right(xr, yy, value, { fg: fg ?? t.text, bold });
    yy++;
  }
  const budget = view.tracker.budget();
  if (yy <= maxY) {
    canvas.put(x, yy, 'Budget', { fg: t.textMuted });
    const text = budget > 0 ? `${formatUsd(budget)} · ${Math.round((cost.usd / budget) * 100)}%` : 'none';
    canvas.right(xr, yy, text, { fg: view.tracker.overBudget() ? t.error : budget > 0 ? t.text : t.textFaint });
    yy++;
  }
  const note = !cost.priced ? 'no known price: press p to set one' : cost.source;
  if (note && yy <= maxY) yy = drawTextBlock(canvas, x, yy, xr - x + 1, [{ text: note, style: { fg: t.textFaint } }], maxY);
  if (view.tracker.hasUnpricedSpend() && budget > 0 && yy <= maxY) {
    yy = drawTextBlock(canvas, x, yy, xr - x + 1, [{ text: 'some spend has no known price and is not counted', style: { fg: t.warning } }], maxY);
  }
  return yy;
}

function drawFleetSplit(f: ModalFrame, view: UsageModalView, x: number, xr: number, y: number, maxY: number): number {
  const t = activeTokens();
  if (y + 1 > maxY) return y;
  const you = view.tracker.sessionCost();
  const fleet = view.tracker.fleetCost();
  f.canvas.put(x, y, 'Fleet', { fg: t.accent, bold: true });
  const text = `you ${you.priced ? formatUsd(you.usd) : 'price unknown'} · agents ${fleet === null ? 'none priced' : formatUsd(fleet)}`;
  return drawTextBlock(f.canvas, x, y + 1, xr - x + 1, [{ text, style: { fg: t.textMuted } }], maxY);
}

/** The per-turn stacked bars (cache read, input, output from the bottom). Returns the row after the legend. */
function drawTurnBars(f: ModalFrame, view: UsageModalView, x: number, xr: number, y: number, maxY: number): number {
  const t = activeTokens();
  const { canvas } = f;
  const turns = view.tracker.turns();
  canvas.put(x, y, 'Per turn', { fg: t.accent, bold: true });
  if (turns.length === 0) {
    return drawTextBlock(canvas, x, y + 2, xr - x + 1, [{ text: 'Token bars appear here after the first completed turn.', style: { fg: t.textMuted } }], maxY);
  }
  const stride = 4;
  const slots = Math.max(1, Math.floor((xr - x + 3) / stride));
  const end = Math.max(0, turns.length - view.turnOffset);
  const start = Math.max(0, end - slots);
  const shown = turns.slice(start, end);
  const countText = view.turnOffset > 0 ? `turns ${start + 1}-${end} of ${turns.length}` : `last ${shown.length}`;
  if (getDisplayWidth(countText) < xr - x - 10) canvas.right(xr, y, countText, { fg: t.textFaint });

  // Rows: header, bars, a number row, blank, legend.
  const legendY = maxY;
  const numbersY = legendY - 2;
  const barTop = y + 1;
  const barBottom = numbersY - 1;
  const barRows = barBottom - barTop + 1;
  if (barRows < 2) return y + 1;
  const totalOf = (turn: UsageTurn): number => turn.input + turn.output + turn.cacheRead;
  const max = Math.max(1, ...shown.map(totalOf));
  shown.forEach((turn, k) => {
    const bx = x + k * stride;
    const scale = barRows / max;
    const parts: Array<[number, string]> = [[turn.cacheRead, t.info], [turn.input, t.brand], [turn.output, t.brandEnd]];
    let heights = parts.map(([n]) => Math.round(n * scale));
    if (heights.every((h) => h === 0) && totalOf(turn) > 0) {
      const largest = parts.reduce((best, part, i) => (part[0] > parts[best]![0] ? i : best), 0);
      heights = heights.map((h, i) => (i === largest ? 1 : h));
    }
    let row = barBottom;
    parts.forEach(([, color], i) => {
      for (let h = 0; h < heights[i]! && row >= barTop; h++, row--) canvas.put(bx, row, '██', { fg: color });
    });
    canvas.put(bx, numbersY, String(start + k + 1).slice(-3), { fg: t.textFaint });
  });
  let lx = x;
  for (const [name, color] of [['input', t.brand], ['output', t.brandEnd], ['cache read', t.info]] as const) {
    if (lx + 2 + getDisplayWidth(name) > xr) break;
    canvas.put(lx, legendY, '■', { fg: color });
    lx = canvas.put(lx + 2, legendY, name, { fg: t.textMuted }) + 3;
  }
  return legendY + 1;
}

function drawOverview(f: ModalFrame, view: UsageModalView, y: number): void {
  const t = activeTokens();
  const { l, r } = f;
  const bottom = view.status ? f.bottom - 2 : f.bottom;
  let yy = drawContext(f, view, y);
  const inner = r - l + 1;
  if (inner >= 60) {
    const leftW = Math.min(34, Math.floor(inner * 0.4));
    const leftR = l + leftW - 1;
    const gx = leftR + 5;
    const leftEnd = drawSessionTable(f, view, l, leftR, yy, bottom);
    drawFleetSplit(f, view, l, leftR, leftEnd + 1, bottom);
    if (bottom - yy >= 5) drawTurnBars(f, view, gx, r, yy, bottom);
  } else {
    yy = drawSessionTable(f, view, l, r, yy, bottom);
    yy = drawFleetSplit(f, view, l, r, yy + 1, bottom);
  }
  if (view.status) f.canvas.put(l, f.bottom, clipText(view.status, inner), { fg: t.textMuted });
}

// ---------------------------------------------------------------------------
// Turns and agents
// ---------------------------------------------------------------------------

function turnRows(view: UsageModalView, width: number): KitRow[] {
  const turns = view.tracker.turns();
  const rows: KitRow[] = [];
  const selected = Math.max(0, turns.length - 1 - view.turnOffset);
  turns.forEach((turn, i) => {
    const total = turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
    const cells = [turn.input, turn.output, turn.cacheRead, turn.cacheWrite].map(formatTokenCount);
    const detail = width >= 60
      ? `in ${cells[0]}  out ${cells[1]}  cache read ${cells[2]}  cache write ${cells[3]}`
      : `in ${cells[0]}  out ${cells[1]}`;
    rows.push({ label: `Turn ${i + 1}`, desc: detail, right: formatTokenCount(total), selected: i === selected });
  });
  return rows;
}

function drawTurns(f: ModalFrame, view: UsageModalView, y: number): void {
  const t = activeTokens();
  const turns = view.tracker.turns();
  if (turns.length === 0) {
    drawTextBlock(f.canvas, f.l, y, f.r - f.l + 1, [{ text: 'No turns recorded yet. Each completed turn adds a row with its input, output and cache tokens.', style: { fg: t.textMuted } }], f.bottom);
    return;
  }
  const result = drawList(f.canvas, { rows: turnRows(view, f.r - f.l + 1), top: y, bottom: f.bottom, x0: f.l, x1: f.r, scrollKey: { owner: view.tracker, name: 'turns' } });
  f.hintRight = scrollCountText(result.above, result.below);
}

function agentMark(agent: UsageAgentEntry): { mark: string; fg: string } {
  const t = activeTokens();
  if (agent.status === 'running') return { mark: '◐', fg: t.brand };
  if (agent.status === 'failed') return { mark: '✕', fg: t.error };
  return { mark: '✓', fg: t.success };
}

function drawAgents(f: ModalFrame, view: UsageModalView, y: number): void {
  const t = activeTokens();
  const agents = view.tracker.agents();
  const session = view.tracker.sessionCost();
  const planCost = agents.reduce((sum, a) => sum + a.cost, 0) + session.usd;
  const running = agents.filter((a) => a.status === 'running').length;
  const failed = agents.filter((a) => a.status === 'failed').length;
  const parts = [`plan total ${session.priced ? formatUsd(planCost) : 'price unknown'}`, `${agents.length} agent${agents.length === 1 ? '' : 's'}`];
  if (running > 0) parts.push(`${running} running`);
  if (failed > 0) parts.push(`${failed} failed`);
  const yy = drawTextBlock(f.canvas, f.l, y, f.r - f.l + 1, [{ text: parts.join(' · '), style: { fg: t.textMuted } }], f.bottom);
  if (agents.length === 0) {
    drawTextBlock(f.canvas, f.l, yy + 1, f.r - f.l + 1, [{ text: 'No agents spawned this session. Agent costs appear here once delegated or background agents start.', style: { fg: t.textMuted } }], f.bottom);
    return;
  }
  const selected = Math.max(0, Math.min(view.agentIndex, agents.length - 1));
  const rows: KitRow[] = agents.map((agent, i) => {
    const { mark, fg } = agentMark(agent);
    const tokens = agent.inputTokens > 0 ? `${formatTokenCount(agent.inputTokens)} in · ${formatTokenCount(agent.outputTokens)} out` : 'no usage yet';
    const cost = agent.inputTokens > 0 && agent.cost === 0 && agent.model === 'unknown' ? 'unpriced' : agent.cost > 0 ? formatUsd(agent.cost) : '-';
    return {
      label: agent.agentId.slice(0, 8),
      desc: `${agent.task} · ${agent.model} · ${tokens}`,
      right: cost,
      mark,
      markFg: fg,
      selected: i === selected,
    };
  });
  const result = drawList(f.canvas, { rows, top: yy + 1, bottom: f.bottom, x0: f.l, x1: f.r, scrollKey: { owner: view.tracker, name: 'agents' } });
  f.hintRight = scrollCountText(result.above, result.below);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function drawEntry(f: ModalFrame, view: UsageModalView, y: number): void {
  const t = activeTokens();
  const entry = view.entry!;
  const width = f.r - f.l + 1;
  let yy = y;
  if (entry.kind === 'budget') {
    yy = drawTextBlock(f.canvas, f.l, yy, width, [
      { text: 'Budget alert', style: { fg: t.accent, bold: true } },
      { text: 'Type a USD amount. You are alerted when this session costs more; 0 turns the alert off. The same setting as /cost budget <usd>.', style: { fg: t.textMuted } },
    ], f.bottom);
    yy++;
    const end = f.canvas.put(f.l, yy, `$${entry.draft}`, { fg: t.text });
    f.canvas.put(end, yy, '▏', { fg: t.brand });
    return;
  }
  const model = view.tracker.modelId();
  if (!view.tracker.canSetModelPrice()) {
    drawTextBlock(f.canvas, f.l, yy, width, [
      { text: 'Model price', style: { fg: t.accent, bold: true } },
      { text: `The current model (${model}) has no provider prefix, so a price cannot be stored for it: prices are keyed provider:model.`, style: { fg: t.textMuted } },
    ], f.bottom);
    return;
  }
  yy = drawTextBlock(f.canvas, f.l, yy, width, [
    { text: `Model price for ${model}`, style: { fg: t.accent, bold: true } },
    { text: 'Your price, in USD per 1M tokens, as input,output (for example 3.00,15.00). It wins over provider and catalog prices everywhere.', style: { fg: t.textMuted } },
  ], f.bottom);
  yy++;
  const end = f.canvas.put(f.l, yy, entry.draft, { fg: t.text });
  f.canvas.put(end, yy, '▏', { fg: t.brand });
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export function renderUsageModal(view: UsageModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, { title: 'Usage', sub: 'this session', hints: hintsFor(view) });
  const labels = USAGE_TABS.map((tab) => TAB_LABELS[tab]);
  const tabRows = view.entry ? 0 : tabRowCount(labels, f.l + 1, f.r - 1);
  if (tabRows > 0) drawTabRows(f.canvas, f.l + 1, f.top, labels, USAGE_TABS.indexOf(view.tab), f.r - 1);
  const y = f.top + (tabRows > 0 ? tabRows + 1 : 0);
  if (view.entry) drawEntry(f, view, y);
  else if (view.tab === 'turns') drawTurns(f, view, y);
  else if (view.tab === 'agents') drawAgents(f, view, y);
  else drawOverview(f, view, y);
  return finishModal(f);
}
