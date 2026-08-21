// ---------------------------------------------------------------------------
// fleet-observed-render.ts, the fleet-pane rows for observed FOREIGN coding
// agents (kind 'observed-external').
//
// goodvibes did NOT spawn these, they are externally-launched Claude Code /
// Codex / opencode sessions, detected read-only from OS signals. The row's
// FIRST job is visibility ("it's in claude or codex"): goodvibes never presents
// itself as the foreign session's cockpit. So an observed row:
//   - shows its honest external kind + a liveness-derived state (active/quiet),
//   - is NEVER counted in any of the panel's own-fleet counts,
//   - carries NO stop affordance, ever,
//   - offers steer as a DRILL-IN only (in the detail view), and only where a
//     real channel exists; where steer.kind is 'none' the detail states why.
// ---------------------------------------------------------------------------

import type { ProcessNode, ProcessObserved, ObservedAgentKind } from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { buildPanelLine, buildSearchInputLine, DEFAULT_PANEL_PALETTE, type PanelPalette } from './polish.ts';
import { truncateDisplay, wrapText } from '../utils/terminal-width.ts';

/** An observed-external node carries its foreign-agent facts on `observed`. */
export type ObservedNode = ProcessNode & { readonly observed: ProcessObserved };

/** True for a foreign observed-agent node (never one of our own fleet rows). */
export function isObservedExternalNode(node: ProcessNode): node is ObservedNode {
  return node.kind === 'observed-external' && node.observed !== undefined;
}

/** The honest plain-language label for an observed foreign agent's kind. */
export function observedKindLabel(kind: ObservedAgentKind): string {
  switch (kind) {
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'opencode': return 'opencode';
    default: return 'unknown agent';
  }
}

/** Liveness glyph: a filled ring while CPU is advancing, a hollow one while quiet. */
function livenessGlyph(state: ProcessObserved['liveness']['state']): string {
  return state === 'active' ? '◉' : '○';
}

/**
 * One observed-external row. Deliberately NOT the standard fleet row: no cost/
 * token/steer-badge columns (a foreign session has no LLM turn we account for),
 * no stop marker, just the glyph, an "observed" tag, the session label, its
 * external kind, and its liveness state.
 */
export function renderObservedRowLine(node: ObservedNode, width: number, palette: PanelPalette = DEFAULT_PANEL_PALETTE): Line {
  const C = palette;
  const observed = node.observed;
  const glyph = livenessGlyph(observed.liveness.state);
  const kindLabel = observedKindLabel(observed.externalKind);
  // The label is width-budgeted so the trailing "kind · state" tell never
  // overflows the row (the tell is the honesty signal, it must survive).
  const tell = `${kindLabel} · ${observed.liveness.state}`;
  const labelBudget = Math.max(4, width - tell.length - 14);
  return buildPanelLine(width, [
    [' ', C.dim],
    [glyph, observed.liveness.state === 'active' ? (C.info ?? DEFAULT_PANEL_PALETTE.info) : C.dim],
    [' observed ', C.dim],
    [truncateDisplay(node.label, labelBudget), C.value],
    ['  ', C.dim],
    [tell, C.dim],
  ]);
}

/**
 * The detail block for a selected observed-external row. States the foreign
 * facts (external kind, pid, cwd, liveness meaning), then the steer affordance,
 * a DRILL-IN: where a real channel exists it names the action; where steer.kind
 * is 'none' it states the honest reason. It NEVER shows a stop affordance,
 * observing a foreign session is not owning its lifecycle.
 */
/**
 * Render the observed-row detail. When `steerDraft` is a string the drill-in
 * steer composer is open on THIS row: an active input line replaces the passive
 * "s: steer" hint. A channel-less row never shows an input (owner ruling), its
 * detail states the honest reason and stops there.
 */
export function renderObservedDetailLines(node: ObservedNode, width: number, palette: PanelPalette = DEFAULT_PANEL_PALETTE, steerDraft: string | null = null): Line[] {
  const C = palette;
  const observed = node.observed;
  const lines: Line[] = [];
  lines.push(buildPanelLine(width, [
    [' ', C.dim],
    [livenessGlyph(observed.liveness.state), observed.liveness.state === 'active' ? (C.info ?? DEFAULT_PANEL_PALETTE.info) : C.dim],
    [' observed ', C.dim],
    [observedKindLabel(observed.externalKind), C.value],
    ['  pid ', C.label],
    [String(observed.pid), C.value],
    ['  state ', C.label],
    [observed.liveness.state, C.value],
  ]));
  if (observed.cwd) {
    lines.push(buildPanelLine(width, [[' cwd ', C.label], [truncateDisplay(observed.cwd, Math.max(0, width - 6)), C.dim]]));
  }
  // Liveness meaning, verbatim, honest about what 'quiet' can and cannot tell.
  for (const segment of wrapText(observed.liveness.detail, Math.max(1, width - 2))) {
    lines.push(buildPanelLine(width, [[' ', C.dim], [segment, C.dim]]));
  }
  // Steer is a drill-in: a real channel is named here (a message sent from this
  // detail travels over it, fleet.observed.steer), and where none exists the
  // honest reason is stated instead of a dead action. Wrapped so a long reason
  // is never clipped at a narrow width.
  const steerText = observed.steer.kind === 'tmux'
    ? `available via tmux pane ${observed.steer.paneId} (send-keys)`
    : `unavailable: ${observed.steer.reason}`;
  const steerFg = observed.steer.kind === 'tmux' ? (C.info ?? DEFAULT_PANEL_PALETTE.info) : C.dim;
  const steerSegments = wrapText(steerText, Math.max(1, width - 8));
  steerSegments.forEach((segment, i) => {
    lines.push(buildPanelLine(width, [[i === 0 ? ' steer ' : '       ', C.label], [segment, steerFg]]));
  });
  // Drill-in compose input: only where a real channel exists. An active draft
  // renders the input line + send/cancel hint; otherwise a discoverability hint.
  if (observed.steer.kind === 'tmux') {
    if (steerDraft !== null) {
      lines.push(buildSearchInputLine(width, ' send ', `${steerDraft}_`, C, { active: true, bg: C.inputBg, valueColor: C.info }));
      lines.push(buildPanelLine(width, [['       ', C.label], ['Enter: send  Esc: cancel', C.dim]]));
    } else {
      lines.push(buildPanelLine(width, [['       ', C.label], ['s: steer this session', C.dim]]));
    }
  }
  // Visibility, not a cockpit: there is no stop here, by design.
  lines.push(buildPanelLine(width, [[' stop ', C.label], ['not offered: goodvibes only observes this foreign session', C.dim]]));
  return lines;
}
