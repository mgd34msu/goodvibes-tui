// ---------------------------------------------------------------------------
// fleet-panel-format.ts
//
// Pure column-layout + cell-formatting helpers for FleetPanel's tree rows.
// Extracted from fleet-panel.ts (file-size hygiene) to hold that file under the
// 800-line architecture cap; these are stateless functions the panel's
// renderItem/renderDetail call, with no `this` dependency.
// ---------------------------------------------------------------------------

import type { ProcessCostState, ProcessNode, ProcessReviewSummary, ProcessUsage } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { buildPanelLine, DEFAULT_PANEL_PALETTE, type ColumnSpec, type PanelPalette } from './polish.ts';
import { fleetAttentionText, fleetNodeAttention, fleetStallMarker, fleetUsageTokens, hasFleetCost, type FleetStateTone } from './fleet-read-model.ts';
import { fleetStateDisplay } from './fleet-stop.ts';
import { formatElapsed } from '../utils/format-elapsed.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { conflictFilesFromRaw, formatWorkItemIsolationDetailFromRaw } from './fleet-panel-worktree-detail.ts';
import { wrapText } from '../utils/terminal-width.ts';
import { buildAlignedRow } from './polish.ts';
import { fleetKindTag } from './fleet-read-model.ts';
import { steerBadgeGlyph, steerBadgeTone } from './fleet-steer.ts';
import type { SteerBadge } from './fleet-tabs.ts';
import type { FleetTreeRow } from './fleet-read-model.ts';
import { isObservedExternalNode, renderObservedDetailLines, renderObservedRowLine } from './fleet-observed-render.ts';
import { renderPoolSummary, type WorkstreamGraphSnapshot } from './workstream-graph-render.ts';

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
  // Observed foreign agents render as their own visibility row (no cost/steer
  // columns, no stop marker) — see fleet-observed-render.ts.
  if (isObservedExternalNode(node)) return renderObservedRowLine(node, width, palette);
  const disp = fleetStateDisplay(node.state, stopping, blocked);
  const color = toneColor(disp.tone, C);
  // Best-of-N grouping: badge a sibling attempt so the N candidates read as one
  // group and a held (pick-ready) candidate is visible (node.attemptGroup, SDK).
  const attemptBadge = node.attemptGroup
    ? ` [attempt ${node.attemptGroup.index + 1}/${node.attemptGroup.total}${node.attemptGroup.held ? ', held' : ''}]`
    : '';
  const label = `${row.treePrefix}${node.label}${attemptBadge}`;
  // Activity column doubles as the badge slot, in priority order:
  //   stopping > waiting-on-human text ('blocked on you' / 'needs your input')
  //   > the read-model HEADLINE (derived from task/phase identity only —
  //   replaced in place, never a scrolling feed) with the stall marker
  //   ('quiet Nm') appended when the node has gone observably silent.
  // Nodes without a headline fall back to the live currentActivity text.
  const attention = fleetNodeAttention(node);
  const stallMarker = fleetStallMarker(node);
  const steadyText = node.headline?.text ?? node.currentActivity?.text ?? '';
  // The stall marker must survive the 20-char activity cell: budget the
  // headline around it (the marker is the honesty signal; a stalled node must
  // never render as if it were healthily mid-headline).
  const steadyWithStall = stallMarker
    ? (steadyText
        ? `${truncateDisplay(steadyText, Math.max(1, ACTIVITY_W - stallMarker.length - 3))} · ${stallMarker}`
        : stallMarker)
    : steadyText;
  const activity = stopping
    ? disp.label
    : blocked
      ? fleetAttentionText(attention ?? { reason: 'approval' })
      : badge
        ? `${steerBadgeGlyph(badge.status)} ${steadyWithStall}`.trimEnd()
        : steadyWithStall;
  const activityColor = stopping
    ? color
    : blocked
      ? color
      : badge
        ? steerBadgeTone(badge.status, C)
        : stallMarker
          ? (C.warn ?? DEFAULT_PANEL_PALETTE.warn)
          : C.dim;

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
/**
 * The reviewer's acceptance checklist + verdict, from the fleet node's served
 * `review` field (ProcessReviewSummary, rides fleet.snapshot/list). Rendered
 * only when a review has completed — never an empty shell. Each item shows
 * whether it was verified, the evidence, and (when present) how it was
 * exercised, matching what the webui's review detail surfaces.
 */
export function renderReviewLines(review: ProcessReviewSummary, width: number, palette: PanelPalette = DEFAULT_PANEL_PALETTE): Line[] {
  const C = palette;
  const passTone = C.good ?? C.info;
  const failTone = C.bad ?? C.warn ?? DEFAULT_PANEL_PALETTE.warn;
  const cyclesLabel = review.cycles === 1 ? '1 cycle' : `${review.cycles} cycles`;
  const lines: Line[] = [
    buildPanelLine(width, [
      [' review ', C.label],
      [review.passed ? '✓ passed' : '✗ not passed', review.passed ? passTone : failTone],
      ['  score ', C.label], [String(review.score), C.value],
      ['  ', C.dim], [cyclesLabel, C.dim],
    ]),
  ];
  if (review.checklist.length === 0) {
    // Empty checklist is itself a gate failure — say so honestly, don't hide it.
    lines.push(buildPanelLine(width, [['   ', C.dim], ['(the reviewer emitted no acceptance checklist — a gate failure)', failTone]]));
    return lines;
  }
  for (const it of review.checklist) {
    const mark = it.verified ? '[verified]  ' : '[unverified]';
    const markTone = it.verified ? passTone : failTone;
    wrapText(it.item, Math.max(1, width - 16)).forEach((seg, i) => {
      lines.push(buildPanelLine(width, i === 0
        ? [['   ', C.dim], [`${mark} `, markTone], [seg, C.value]]
        : [['                ', C.dim], [seg, C.value]]));
    });
    if (it.evidence) {
      for (const seg of wrapText(`evidence: ${it.evidence}`, Math.max(1, width - 6))) {
        lines.push(buildPanelLine(width, [['     ', C.dim], [seg, C.dim]]));
      }
    }
    if (it.howExercised) {
      for (const seg of wrapText(`exercised: ${it.howExercised}`, Math.max(1, width - 6))) {
        lines.push(buildPanelLine(width, [['     ', C.dim], [seg, C.dim]]));
      }
    }
  }
  return lines;
}

/**
 * The task graph's edges + elastic-pool posture for a workstream row, rendered
 * IN the fleet detail (the tree shows nodes; edges/pool used to be reachable
 * only via /graph — /graph still works). Fetched lazily and cached by fleet-acts;
 * rendered only once a snapshot is in hand. An empty graph states so honestly.
 */
export function renderGraphPostureLines(graph: WorkstreamGraphSnapshot, width: number, palette: PanelPalette = DEFAULT_PANEL_PALETTE): Line[] {
  const C = palette;
  const lines: Line[] = [
    buildPanelLine(width, [[' graph ', C.label], [renderPoolSummary(graph.pool), C.value]]),
  ];
  if (graph.edges.length === 0) {
    lines.push(buildPanelLine(width, [['   ', C.dim], ['no dependency edges', C.dim]]));
    return lines;
  }
  const titleById = new Map(graph.nodes.map((n) => [n.id, n.title]));
  lines.push(buildPanelLine(width, [[' edges ', C.label], [`${graph.edges.length} dependency link(s)`, C.value]]));
  for (const edge of graph.edges) {
    const from = titleById.get(edge.from) ?? edge.from;
    const to = titleById.get(edge.to) ?? edge.to;
    for (const seg of wrapText(`${from} → ${to}`, Math.max(1, width - 5))) {
      lines.push(buildPanelLine(width, [['   ', C.dim], [seg, C.dim]]));
    }
  }
  return lines;
}

export function renderFleetDetailLines(
  node: ProcessNode,
  width: number,
  stopping: boolean,
  blocked: boolean,
  palette: PanelPalette = DEFAULT_PANEL_PALETTE,
  observedSteerDraft: string | null = null,
  graphSnapshot: WorkstreamGraphSnapshot | null = null,
): Line[] {
  const C = palette;
  // Observed foreign agents drill into their own detail (facts + steer-or-reason,
  // never a stop) — see fleet-observed-render.ts. The drill-in steer draft (when
  // the composer is open on this row) renders an input line in that detail.
  if (isObservedExternalNode(node)) return renderObservedDetailLines(node, width, palette, observedSteerDraft);
  const disp = fleetStateDisplay(node.state, stopping, blocked);
  const color = toneColor(disp.tone, C);
  // A blocked node's state text names WHY in the reason's own words
  // ('needs your pick' / 'merge conflict waiting on you' / …) so the detail
  // block never contradicts the row's reason-specific badge; the shared ⚑
  // glyph/tone (disp) is unchanged. 'stopping' still wins over the reason.
  const stateLabel = blocked && !stopping
    ? fleetAttentionText(fleetNodeAttention(node) ?? { reason: 'approval' })
    : disp.label;

  const line1 = buildPanelLine(width, [
    [' ', C.dim],
    [disp.glyph, color],
    [` ${node.kind}`, C.dim],
    ['  id ', C.label],
    [node.id, C.value],
    ['  state ', C.label],
    [stateLabel, color],
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
  // The headline (task/phase identity, replaced in place) gets its own row
  // when present, with the stall marker appended — the detail block mirrors
  // exactly what the tree row's steady slot shows.
  const stallMarker = fleetStallMarker(node);
  const headlineText = node.headline
    ? `${node.headline.text}${stallMarker ? ` · ${stallMarker}` : ''}`
    : stallMarker;
  const headlineLine = headlineText
    ? [buildPanelLine(width, [
        [' headline ', C.label],
        [truncateDisplay(headlineText, Math.max(0, width - 11)), stallMarker ? (C.warn ?? DEFAULT_PANEL_PALETTE.warn) : C.value],
      ])]
    : [];
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
  // A merge-conflict row shows its STRUCTURED conflicting-path list, wrapped so a
  // long path is fully readable — never clipped (STEP 4: the conflict row acts,
  // and the operator sees exactly which files need resolving before pressing Enter).
  const conflictFiles = node.kind === 'work-item' ? conflictFilesFromRaw(node.raw) : null;
  const conflictLines: Line[] = conflictFiles
    ? [
      buildPanelLine(width, [[' conflicts ', C.label], [`${conflictFiles.length} file(s) — press Enter to resolve`, C.warn ?? DEFAULT_PANEL_PALETTE.warn]]),
      // Prefix is 3 spaces of indent + a 2-col bullet/continuation marker, so
      // wrap the path at width-5 to keep the composed line within `width`
      // (a hard-wrapped long path is fully readable, never clipped).
      ...conflictFiles.flatMap((file) =>
        wrapText(file, Math.max(1, width - 5)).map((segment, i) =>
          buildPanelLine(width, [['   ', C.dim], [i === 0 ? `• ${segment}` : `  ${segment}`, C.value]]),
        ),
      ),
    ]
    : [];
  // The reviewer's acceptance checklist + verdict, when a review has completed
  // (served on node.review; absent before any review — never an empty shell).
  const reviewLines = node.review ? renderReviewLines(node.review, width, C) : [];
  // The task graph's edges/pool posture for a workstream row (fetched + cached
  // by fleet-acts); rendered in-panel under the chain, /graph still available.
  const graphLines = graphSnapshot ? renderGraphPostureLines(graphSnapshot, width, C) : [];
  return [line1, line2, ...headlineLine, line3, line4, ...(isolationDetail ? [buildPanelLine(width, [[' isolation ', C.label], [isolationDetail, C.dim]])] : []), ...conflictLines, ...reviewLines, ...graphLines];
}
