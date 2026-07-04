// ---------------------------------------------------------------------------
// fleet-deep-link.ts — DEBT-5 item 4.
//
// PanelManager.open('fleet', pane, target) hands FleetPanel a
// PanelDeepLinkTarget (a process id + optional ProcessKind) so a cross-panel
// jump (the work-plan modal's 'i'/'w' agent/WRFC-chain jumps, the docs
// modal's tools-tab Enter) can select + reveal a SPECIFIC node instead of
// just opening Fleet generically. Extracted from fleet-panel.ts (already at
// the 800-line architecture cap) so the panel stays a thin caller.
//
// `kind`, when given, must also match: ProcessNode ids are unique per the
// SDK's own contract, so this is a cheap extra honesty check, not the
// primary lookup key. Reveal is "free" once selectedIndex is set —
// ScrollableListPanel's render-time scroll-window resolution keeps the
// selected row visible, so FleetPanel.receiveDeepLink does not need its own
// scroll math.
//
// A target that isn't found (pruned, killed, never existed, or a domain —
// like the docs Tools tab's static tool definitions — that has no
// corresponding fleet node at all) resolves to -1; the caller degrades
// honestly (FleetPanel.setError('node no longer present.')) rather than
// silently landing on an unrelated row.
// ---------------------------------------------------------------------------

import type { PanelDeepLinkTarget } from './types.ts';
import type { FleetTreeRow } from './fleet-read-model.ts';

/** The row index matching `target`'s id (+ kind, if given), or -1. Pure — no I/O, no mutation. */
export function resolveFleetDeepLinkIndex(rows: readonly FleetTreeRow[], target: PanelDeepLinkTarget): number {
  return rows.findIndex((row) => row.node.id === target.id && (!target.kind || row.node.kind === target.kind));
}
