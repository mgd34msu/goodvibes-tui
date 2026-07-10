// ---------------------------------------------------------------------------
// fleet-panel-format.ts
//
// Pure column-layout + cell-formatting helpers for FleetPanel's tree rows.
// Extracted from fleet-panel.ts (file-size hygiene) to hold that file under the
// 800-line architecture cap; these are stateless functions the panel's
// renderItem/renderDetail call, with no `this` dependency.
// ---------------------------------------------------------------------------

import type { ProcessCostState, ProcessNode, ProcessUsage } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { Line } from '../types/grid.ts';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE, type ColumnSpec, type PanelPalette } from './polish.ts';
import { fleetUsageTokens, hasFleetCost, type FleetStateTone } from './fleet-read-model.ts';
import { fleetStateDisplay } from './fleet-stop.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { formatWorkItemIsolationDetailFromRaw } from './fleet-panel-worktree-detail.ts';
import { buildAlignedRow } from './polish.ts';
import { fleetKindTag } from './fleet-read-model.ts';
import { steerBadgeGlyph, steerBadgeTone } from './fleet-steer.ts';
import type { SteerBadge } from './fleet-tabs.ts';
import type { FleetTreeRow } from './fleet-read-model.ts';

// Column widths for the tree row layout. `label` absorbs whatever width is
// left over after the fixed columns + gaps; on hostile (narrow) widths the
// trailing columns simply clip (buildAlignedRow/buildSelectablePanelLine stop
// writing once a cell would overflow the row) rather than throwing or
// wrapping — the tree stays readable, just denser.
const KIND_W = 8;
const ELAPSED_W = 7;
const TOKENS_W = 7;
const COST_W = 8;
const ACTIVITY_W = 20;
const GAP = 1;
const FIXED_W = 1 /* glyph */ + KIND_W + ELAPSED_W + TOKENS_W + COST_W + ACTIVITY_W + GAP * 6;

export function planColumns(width: number): ColumnSpec[] {
  const labelWidth = Math.max(10, width - FIXED_W);
  return [
    { width: 1 },
    { width: KIND_W },
    { width: labelWidth },
    { width: ELAPSED_W, align: 'right' },
    { width: TOKENS_W, align: 'right' },
    { width: COST_W, align: 'right' },
    { width: ACTIVITY_W },
  ];
}

export function toneColor(tone: FleetStateTone, palette: PanelPalette): string {
  switch (tone) {
    case 'active': return palette.info ?? DEFAULT_PANEL_PALETTE.info;
    case 'success': return palette.good ?? DEFAULT_PANEL_PALETTE.good;
    case 'failure': return palette.bad ?? DEFAULT_PANEL_PALETTE.bad;
    case 'warn': return palette.warn ?? DEFAULT_PANEL_PALETTE.warn;
    case 'muted': return palette.dim;
  }
}

export function formatFleetTokens(usage: ProcessUsage | undefined): string {
  const total = fleetUsageTokens(usage);
  if (total === null) return 'n/a';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

/** Honest cost display: never a fabricated $0.00 — 'unpriced' when costState says so. */
export function formatFleetCost(costUsd: number | null | undefined, costState: ProcessCostState): string {
  if (!hasFleetCost(costUsd, costState)) return 'unpriced';
  const formatted = formatAgentCost(costUsd as number);
  return costState === 'estimated' ? `~${formatted}` : formatted;
}

/**
 * One fleet tree row. Pure (extracted from FleetPanel.renderItem for the
 * 800-line cap). Two display-only overrides in priority order: an in-flight
 * `stopping` wins the glyph/label/activity, then a `blocked`-on-user node gets
 * the ⚑ badge + 'blocked on you' in the activity slot. Otherwise a queued-steer
 * badge (if any) prefixes the live activity text.
 */
export function renderFleetRowLine(
  row: FleetTreeRow,
  width: number,
  stopping: boolean,
  blocked: boolean,
  badge: SteerBadge | null,
  palette: PanelPalette = DEFAULT_PANEL_PALETTE,
): Line {
  const C = palette;
  const node = row.node;
  const disp = fleetStateDisplay(node.state, stopping, blocked);
  const color = toneColor(disp.tone, C);
  // Best-of-N grouping: badge a sibling attempt so the N candidates read as one
  // group and a held (pick-ready) candidate is visible (node.attemptGroup, SDK).
  const attemptBadge = node.attemptGroup
    ? ` [attempt ${node.attemptGroup.index + 1}/${node.attemptGroup.total}${node.attemptGroup.held ? ', held' : ''}]`
    : '';
  const label = `${row.treePrefix}${node.label}${attemptBadge}`;
  // Activity column doubles as the badge slot: 'blocked on you' shouts the
  // wait louder than the raw currentActivity text ('awaiting approval …').
  const activity = stopping
    ? disp.label
    : blocked
      ? 'blocked on you'
      : badge
        ? `${steerBadgeGlyph(badge.status)} ${node.currentActivity?.text ?? ''}`.trimEnd()
        : (node.currentActivity?.text ?? '');
  const activityColor = stopping ? color : blocked ? color : badge ? steerBadgeTone(badge.status, C) : C.dim;

  return buildAlignedRow(
    width,
    [
      { text: disp.glyph, fg: color },
      { text: fleetKindTag(node.kind), fg: C.dim },
      { text: label, fg: C.value },
      { text: formatElapsed(node.elapsedMs), fg: C.dim },
      { text: formatFleetTokens(node.usage), fg: C.dim },
      { text: formatFleetCost(node.costUsd, node.costState), fg: C.value },
      { text: activity, fg: activityColor },
    ],
    planColumns(width),
  );
}

/**
 * The selected-node detail block under the fleet tree. Pure (extracted from
 * FleetPanel.renderDetail to hold that file under the 800-line architecture
 * cap). `stopping`/`blocked` are display-only overrides the caller derives from
 * the stop tracker + node state — mirror the tree row exactly so the literal
 * 'state' text never claims a past-tense outcome mid-write, and a
 * blocked-on-user node reads 'blocked on you' here too.
 */
export function renderFleetDetailLines(
  node: ProcessNode,
  width: number,
  stopping: boolean,
  blocked: boolean,
  palette: PanelPalette = DEFAULT_PANEL_PALETTE,
): Line[] {
  const C = palette;
  const disp = fleetStateDisplay(node.state, stopping, blocked);
  const color = toneColor(disp.tone, C);

  const line1 = buildPanelLine(width, [
    [' ', C.dim],
    [disp.glyph, color],
    [` ${node.kind}`, C.dim],
    ['  id ', C.label],
    [node.id, C.value],
    ['  state ', C.label],
    [disp.label, color],
    ['  elapsed ', C.label],
    [formatElapsed(node.elapsedMs), C.value],
  ]);
  const line2 = buildPanelLine(width, [
    [' model ', C.label],
    [node.model ?? 'unknown', C.info],
    ['  tokens ', C.label],
    [formatFleetTokens(node.usage), C.value],
    ['  cost ', C.label],
    [formatFleetCost(node.costUsd, node.costState), C.value],
  ]);
  const activityText = node.currentActivity
    ? `${node.currentActivity.kind}: ${node.currentActivity.text}`
    : '(no recent activity)';
  const line3 = buildPanelLine(width, [
    [' activity ', C.label],
    [truncateDisplay(activityText, Math.max(0, width - 11)), C.dim],
  ]);
  // Approval history attaches here once session tabs land.
  const line4 = buildPanelLine(width, [[' approvals ', C.label], ['—', C.dim]]);
  const isolationDetail = node.kind === 'work-item' ? formatWorkItemIsolationDetailFromRaw(node.raw) : null;
  return [line1, line2, line3, line4, ...(isolationDetail ? [buildPanelLine(width, [[' isolation ', C.label], [isolationDetail, C.dim]])] : [])];
}
