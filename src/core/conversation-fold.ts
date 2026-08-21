/**
 * conversation-fold.ts, which transcript rows render FOLDED, and what spacing
 * that earns them.
 *
 * A folded tool result is exactly ONE row: its header, with the preview riding
 * on the same line after the `▸ N lines` badge. It used to be four rows, a
 * `▄▄▄` cap, an interior preview line carrying a second `[▸ N hidden]` count, a
 * `▀▀▀` cap, and a blank after all of it, for one line of text the header had
 * already sized.
 *
 * These predicates live in their own leaf module because TWO callers must agree
 * on them and neither may depend on the other: the row renderer
 * (conversation-rendering.ts) decides how to draw the row, and the line cache
 * (conversation-line-cache.ts) decides the blank separator that follows it. If
 * those two ever disagreed about which rows are folded, a warm cache and a cold
 * rebuild would space the transcript differently, the exact class of bug the
 * cache's byte-identical contract exists to rule out.
 *
 * Everything here is PURE: collapse state is read, never written, so a row can
 * be asked about before it has rendered.
 */

import { foldedToolResult, trailingBlankAfterRow } from '@pellux/goodvibes-terminal-shell';
import { summarizeToolResult } from '../renderer/tool-result-summary.ts';
import { isTurnCollapsed, type ConversationRenderContext } from './conversation-render-context.ts';
import { collapseKeyForNode, type RenderNode } from './conversation-turn-structure.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';

/** The subset of a render context these predicates read. */
type FoldContext = Pick<ConversationRenderContext, 'assistantTurns' | 'collapseState'>;

/**
 * Does a tool-result row render FOLDED, one compact header row with its preview
 * on it, rather than header-plus-expanded-body?
 *
 * An unset collapse key answers the same as the default the row itself will
 * store (collapsed), so asking before and asking after the row renders give the
 * same answer.
 */
export function isToolResultFolded(
  message: Extract<ConversationMessageSnapshot, { role: 'tool' }>,
  collapseState: ReadonlyMap<string, boolean>,
  collapseKey: string,
): boolean {
  // Threading only, the decision, the short-content threshold and the
  // unset-key default all belong to foldedToolResult(). summarizeToolResult is
  // this product's own renderer concern, so resolving it stays here: a
  // summarizable result stays folded even when short, because the one-line
  // summary is the better row and the raw payload belongs behind the toggle.
  return foldedToolResult({
    contentLength: message.content.length,
    hasSummary: summarizeToolResult(message.toolName, message.content) !== null,
    storedCollapsed: collapseState.get(collapseKey),
  });
}

/** A row that belongs to a tool run: the call itself, or the result under it. */
function isToolRunNode(node: RenderNode): boolean {
  return node.kind === 'toolcall' || node.message.role === 'tool';
}

/**
 * Does this planned row emit exactly one folded tool-result line?
 *
 * A collapsed turn hides the row entirely, so there is no folded row to butt up
 * against the next one.
 */
function rendersFoldedToolRow(node: RenderNode, context: FoldContext): boolean {
  if (node.kind === 'toolcall') return false;
  const message = node.message;
  if (message.role !== 'tool') return false;
  if (isTurnCollapsed(context.assistantTurns?.get(node.absIdx), context.collapseState)) return false;
  return isToolResultFolded(message, context.collapseState, collapseKeyForNode(node));
}

/**
 * The blank separator that follows a planned row.
 *
 * Branch rows sit tight under their parent, so the blank lands only after the
 * last row of a top-level unit, that is what keeps a turn's whole subtree
 * reading as one block. On top of that, a folded row followed by more tool
 * machinery gets NO blank at all: N consecutive folded results stack as N
 * adjacent single rows. A folded row followed by anything that is not tool
 * machinery keeps its blank, so the run still separates from the prose around
 * it.
 */
export function trailingBlankAfter(
  node: RenderNode,
  next: RenderNode | undefined,
  context: FoldContext,
): boolean {
  // Adaptation only, RenderNode is this product's shape, so reading depth and
  // node kind off it stays here; the rule those facts feed belongs to
  // trailingBlankAfterRow(). No `next` at all means end of transcript: neither
  // a branch row nor tool machinery follows, which is the plain-blank case.
  return trailingBlankAfterRow({
    nextIsBranchRow: next !== undefined && next.depth !== 0,
    nextIsToolMachinery: next !== undefined && isToolRunNode(next),
    rowRendersFolded: rendersFoldedToolRow(node, context),
  });
}
