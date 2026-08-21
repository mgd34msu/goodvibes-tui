// ---------------------------------------------------------------------------
// workstream-graph-render.ts, render a workstream's task graph (fleet.graph.get)
// legibly, so the observability layer shows the dependency graph's shape,
// states, and pool posture WITHOUT opening any transcript.
//
// The SDK serves a WorkstreamGraphSnapshot: nodes (id/title/state, plus
// blockedReason, orphaned, stalled, agentId), edges (from → to dependency
// links), and the elastic-pool state (ready/running/atCap/maxSize). This module
// is a pure string renderer; every line is fit to the given width (no clipping,
// no horizontal overflow), so the same output drives a panel or a command.
// ---------------------------------------------------------------------------

import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';
import { truncateDisplay, getDisplayWidth } from '../utils/terminal-width.ts';

export type WorkstreamGraphSnapshot = OperatorMethodOutput<'fleet.graph.get'>;
export type WorkstreamGraphNode = WorkstreamGraphSnapshot['nodes'][number];

/** The pool posture line: "N ready, M running[, at cap (fleet.maxSize=N)]". */
export function renderPoolSummary(pool: WorkstreamGraphSnapshot['pool']): string {
  if (!pool) return 'no pool state';
  const base = `${pool.ready} ready, ${pool.running} running`;
  return pool.atCap ? `${base}, at cap (fleet.maxSize=${pool.maxSize})` : base;
}

/** The leading glyph for a node, orphaned/blocked/stalled tells win over the base state. */
function nodeGlyph(node: WorkstreamGraphNode): string {
  if (node.orphaned) return '⊘';
  if (node.blockedReason) return '⊘';
  if (node.stalled) return '◒';
  switch (node.state) {
    case 'running': return '●';
    case 'ready': return '○';
    case 'done': return '✓';
    case 'failed': return '✕';
    default: return '·';
  }
}

/** The state tell for a node: the "waiting on: X" for blocked, running/ready, plus orphaned/stalled markers. */
function nodeTell(node: WorkstreamGraphNode, needs: readonly string[]): string {
  const parts: string[] = [];
  if (node.blockedReason) {
    parts.push(`blocked: waiting on: ${node.blockedReason}`);
  } else if (node.state === 'running') {
    parts.push(node.agentId ? `running (${node.agentId})` : 'running');
  } else if (node.state === 'ready') {
    parts.push('ready');
  } else {
    parts.push(node.state);
  }
  if (needs.length > 0 && !node.blockedReason) parts.push(`needs: ${needs.join(', ')}`);
  if (node.orphaned) parts.push('orphaned');
  if (node.stalled) parts.push('stalled');
  return parts.join(' · ');
}

/** Fit a line to the width without overflowing (truncates with an ellipsis). */
function fit(line: string, width: number): string {
  return getDisplayWidth(line) > width ? truncateDisplay(line, width) : line;
}

/**
 * Wrap content to the width on word boundaries, NO clipping: the whole tell
 * (including a long "waiting on: …" reason) survives onto indented continuation
 * lines rather than being cut off. `firstIndent` leads the first line;
 * `contIndent` leads each continuation. A single word longer than the width is
 * hard-fit defensively so a line never overflows.
 */
function wrapContent(content: string, width: number, firstIndent: string, contIndent: string): string[] {
  const words = content.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = firstIndent;
  let hasWord = false;
  for (const word of words) {
    const candidate = hasWord ? `${cur} ${word}` : `${cur}${word}`;
    if (getDisplayWidth(candidate) > width && hasWord) {
      out.push(cur);
      cur = `${contIndent}${word}`;
    } else {
      cur = candidate;
    }
    hasWord = true;
  }
  if (hasWord) out.push(cur);
  return out.map((l) => (getDisplayWidth(l) > width ? fit(l, width) : l));
}

/**
 * Render the whole snapshot as legible lines, each fit to `width`. The header
 * carries the pool posture; every node is one line with its glyph, title, and
 * state tell (ready / running / blocked-with-waiting-on / stalled / orphaned),
 * with its dependency edges named inline ("needs: …"). An empty graph states so
 * honestly rather than rendering a blank surface.
 */
export function renderWorkstreamGraphLines(snapshot: WorkstreamGraphSnapshot, width: number): string[] {
  const lines: string[] = [];
  // Title and pool posture on their own lines so neither clips the other at a
  // narrow width, the pool summary ("… at cap (fleet.maxSize=N)") is load-bearing.
  lines.push(fit(snapshot.title, width));
  lines.push(fit(`  ${renderPoolSummary(snapshot.pool)}`, width));

  if (snapshot.nodes.length === 0) {
    lines.push(fit('  (no work items in this workstream)', width));
    return lines;
  }

  const titleById = new Map<string, string>();
  for (const node of snapshot.nodes) titleById.set(node.id, node.title);
  const needsByNode = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const list = needsByNode.get(edge.to) ?? [];
    list.push(titleById.get(edge.from) ?? edge.from);
    needsByNode.set(edge.to, list);
  }

  for (const node of snapshot.nodes) {
    const glyph = nodeGlyph(node);
    const tell = nodeTell(node, needsByNode.get(node.id) ?? []);
    lines.push(...wrapContent(`${glyph} ${node.title}  ${tell}`, width, '  ', '      '));
  }
  return lines;
}
