// ---------------------------------------------------------------------------
// fleet-panel-format.ts
//
// Pure column-layout + cell-formatting helpers for FleetPanel's tree rows.
// Extracted from fleet-panel.ts (file-size hygiene) to hold that file under the
// 800-line architecture cap; these are stateless functions the panel's
// renderItem/renderDetail call, with no `this` dependency.
// ---------------------------------------------------------------------------

import type { ProcessCostState, ProcessUsage } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { formatAgentCost } from './agent-inspector-shared.ts';
import { DEFAULT_PANEL_PALETTE, type ColumnSpec, type PanelPalette } from './polish.ts';
import { fleetUsageTokens, hasFleetCost, type FleetStateTone } from './fleet-read-model.ts';

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
