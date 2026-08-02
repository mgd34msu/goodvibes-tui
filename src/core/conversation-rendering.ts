import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdownTracked } from '../renderer/markdown.ts';
import { isDiffContent, renderExpandedToolResultLines } from '../renderer/tool-result-expanded-lines.ts';
import { activeTheme, activeUiTones } from '../renderer/theme.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { summarizeToolResult } from '../renderer/tool-result-summary.ts';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { renderThinkingBlock } from '../renderer/thinking.ts';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { createEmptyLine, type Line, type Cell } from '@pellux/goodvibes-sdk/platform/types';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { BORDERS, LAYOUT, TOOL_STATUS } from '../renderer/layout.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { renderConversationEventLine, renderConversationFoldedRow } from '../renderer/conversation-surface.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import type { BlockMeta } from './conversation-types.ts';
import {
  collectToolCallOutcomes,
  isTurnCollapsed,
  type ConversationRenderContext,
} from './conversation-render-context.ts';
import { renderCompactionContinuationMessage } from './conversation-compaction-render.ts';
// Which rows fold, and the blank separator that earns — shared verbatim with
// conversation-line-cache.ts so a warm cache and a cold rebuild space alike.
import { isToolResultFolded, trailingBlankAfter } from './conversation-fold.ts';
import { drawTreeRails, treeIndentCols, treeTextCol } from '@pellux/goodvibes-terminal-shell';
import {
  MAX_NEST_DEPTH,
  buildRenderPlan,
  collapseKeyForNode,
  computeAssistantTurns,
  type AssistantTurnMembership,
  type RenderNode,
} from './conversation-turn-structure.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { parseDiffForApply } from '@pellux/goodvibes-sdk/platform/core';
import { extractUserDisplayText, COMPACTION_HANDOFF_HEADER } from '@pellux/goodvibes-sdk/platform/core';
// SystemMessageKind imported from runtime directly to avoid cycle:
//   conversation-rendering.ts → system-message-router.ts → conversation.ts → conversation-rendering.ts
import type { SystemMessageKind } from '@/runtime/index.ts';

// Transcript tokens are read live per render (const T = activeTheme() at the top
// of each render function that styles content) so a dark→light repaint
// re-resolves with no module reload. See theme.ts's active-mode runtime note.

/**
 * Navigable system message kinds for error-navigation (nextErrorLine/prevErrorLine).
 *
 * Kind → navigable mapping:
 *   - 'system'      YES — generic/catch-all messages (provider failures, session
 *                         events, user-visible errors). Default for un-prefixed messages.
 *   - 'wrfc'        YES — WRFC chain events are important and worth navigating to.
 *   - 'operational' NO  — tool/scan/plugin/MCP status noise; not useful to jump to.
 *
 * When a message has no recorded kind (added via bare addSystemMessage), it
 * defaults to 'system' and is therefore navigable.
 */
const NAVIGABLE_KINDS: ReadonlySet<SystemMessageKind> = new Set(['system', 'wrfc']);

type Message = ConversationMessageSnapshot;

// The render context and its pure derivations live in a type-only leaf module
// (conversation-render-context.ts) so per-row render modules can depend on the
// SHAPE of a render without depending on this drawing module. Re-exported here
// because this file remains the transcript renderer's entry point.
export {
  collectCompletedToolCallIds,
  collectToolCallOutcomes,
  isTurnCollapsed,
  type ConversationRenderContext,
  type ToolCallOutcome,
} from './conversation-render-context.ts';

function summarizeCallId(callId: string, maxLength = 24): string {
  return callId.length <= maxLength ? callId : `${callId.slice(0, maxLength - 1)}…`;
}

export function renderConversationUserMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'user' }>,
  width: number,
  msgIdx?: number,
): void {
  const T = activeTheme();
  const displayText = extractUserDisplayText(message.content);
  if (message.cancelled) {
    context.history.addLines(UIFactory.createMessageBar(width, displayText, T.errorBarBg, '196', ' x ', true));
    return;
  }
  // Compaction-continuation handoff: a user-ROLE message the compactor
  // authored, not something the user typed. Rendered in full it repeats the
  // entire re-injected instruction block after every automatic compaction —
  // a multi-kilobyte wall in the transcript. Fold it like a tool result; the
  // full payload stays reachable through the normal expand toggle.
  if (msgIdx !== undefined && displayText.startsWith(COMPACTION_HANDOFF_HEADER)) {
    renderCompactionContinuationMessage(context, displayText, width, msgIdx);
    return;
  }
  context.history.addLines(UIFactory.createMessageBar(width, displayText));
}

export function renderConversationAssistantMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'assistant' }>,
  width: number,
  lineNumberMode: 'all' | 'code' | 'off',
  collapseThreshold: number,
  msgIdx: number,
): void {
  const T = activeTheme();
  const turn = context.assistantTurns?.get(msgIdx);
  // No membership (a standalone render, e.g. a golden-frame harness) behaves
  // exactly as it always did: the message owns its own header.
  const isHead = turn?.isHead ?? true;
  const turnCollapsed = isTurnCollapsed(turn, context.collapseState);

  if (isHead) {
    const assistantHeaderDetails = [];
    if (message.model) {
      assistantHeaderDetails.push({ text: ` ${message.model}${message.provider ? ` (${message.provider})` : ''} `, fg: T.modelNameDim, dim: true });
    }
    // The count spans the whole run, not just this message — that is the point
    // of merging. `tools:1` repeated over five headers becomes one `5 tools`.
    const toolCount = turn?.toolCallCount ?? message.toolCalls?.length ?? 0;
    if (toolCount > 0) {
      assistantHeaderDetails.push({ text: ` ${GLYPHS.status.pending} ${toolCount} tool${toolCount === 1 ? '' : 's'} `, fg: T.toolAccent });
    }
    // A label every call in the run shares belongs here, once, instead of on
    // every branch — the branches then lead with what distinguishes them.
    //
    // Hoisted ONLY when it fits whole. A label chopped mid-word ("Calling the
    // assistant serv") is worse than no label: it costs a third of the header
    // and tells you less than the rows below it already do, since each row
    // leads with its own distinguishing token. So it either fits or it goes —
    // never a truncated stub. Dropping it loses nothing reachable: the rows
    // still name every call, and omitToolName is unaffected either way.
    if (turn?.sharedToolLabel) {
      const usedCols = assistantHeaderDetails.reduce((sum, seg) => sum + getDisplayWidth(seg.text), 0);
      const availCols = width - LAYOUT.RIGHT_MARGIN - (LAYOUT.LEFT_MARGIN + 1)
        - getDisplayWidth(' assistant ') - usedCols;
      const labelText = ` ${turn.sharedToolLabel} `;
      if (getDisplayWidth(labelText) <= availCols) {
        assistantHeaderDetails.push({ text: labelText, fg: T.toolNameFg });
      }
    }
    // Aggregated across the run so suppressing a non-head's header never loses
    // the signal that reasoning happened.
    const hasReasoning = turn?.hasReasoning ?? Boolean(message.reasoningContent || message.reasoningSummary);
    if (hasReasoning) {
      assistantHeaderDetails.push({ text: ` ${GLYPHS.status.active} reasoning `, fg: T.reasoningAccent, dim: true });
    }
    if (turnCollapsed && toolCount > 0) {
      assistantHeaderDetails.push({ text: ` ${GLYPHS.navigation.collapsed} hidden `, fg: '244', dim: true });
    }
    // An empty run — no model, no tools, no reasoning — emits no header rather
    // than a bare `● assistant` with nothing under it.
    if (assistantHeaderDetails.length > 0) {
      const headerStartLine = context.history.getLineCount();
      const headerBlockIdx = context.blockRegistry.length;
      context.history.addLine(renderConversationEventLine(width, {
        marker: GLYPHS.status.active,
        markerFg: T.assistantHeader,
        label: 'assistant',
        labelFg: T.assistantHeader,
        detailFg: '244',
      }, assistantHeaderDetails));

      // Turns are collapsible as a unit and default to EXPANDED — a turn
      // collapsed by default would hide the activity the transcript exists to
      // show. Registered only when there is machinery to hide.
      if (turn && toolCount > 0) {
        if (!context.collapseState.has(turn.turnKey)) {
          context.collapseState.set(turn.turnKey, false);
        }
        context.blockRegistry.push({
          blockIndex: headerBlockIdx,
          collapseKey: turn.turnKey,
          type: 'assistant_turn',
          startLine: headerStartLine,
          lineCount: 1,
          rawContent: `assistant turn — ${toolCount} tool call${toolCount === 1 ? '' : 's'}${turn.sharedToolLabel ? ` (${turn.sharedToolLabel})` : ''}`,
          groupMemberIndexes: turn.resultIndexes,
          toolName: turn.sharedToolLabel,
        });
      }
    }
  }

  // A collapsed turn hides its machinery (tool rows, reasoning) but never its
  // prose: the prose IS the answer, and hiding it would make collapse
  // destructive rather than tidying.
  if (turnCollapsed) {
    if (message.content) renderAssistantProse(context, message, width, lineNumberMode, collapseThreshold, msgIdx);
    return;
  }

  const showThinking = context.configManager?.get('display.showThinking') ?? false;
  const showReasoningSummary = context.configManager?.get('display.showReasoningSummary') ?? false;
  if (showThinking && message.reasoningContent) {
    const thinkingStartLine = context.history.getLineCount();
    const thinkingBlockIdx = context.blockRegistry.length;
    const thinkingCollapseKey = `msg_${msgIdx}_thinking`;
    // Collapsed by default, like every other collapsible block — Tab (or the
    // block-actions menu) expands it via the same collapseKey the BlockMeta
    // below registers. Previously this key was registered but never
    // consulted: the toggle existed but did nothing.
    const isThinkingCollapsed = context.collapseState.has(thinkingCollapseKey)
      ? context.collapseState.get(thinkingCollapseKey)!
      : true;
    if (!context.collapseState.has(thinkingCollapseKey)) {
      context.collapseState.set(thinkingCollapseKey, true);
    }
    if (isThinkingCollapsed) {
      // One row: label plus size badge, no frame and no interior line.
      //
      // Deliberately NO preview, unlike a folded tool result. Reasoning text
      // stays behind the toggle until it is asked for — the fold is the quiet
      // state of an already-opt-in display, and previewing the first reasoning
      // line here would disclose content the collapsed form has never shown.
      const thinkingLineCount = message.reasoningContent.split('\n').length;
      context.history.addLine(renderConversationFoldedRow(width, {
        // The same ▌ the EXPANDED block draws (BORDERS.THINKING), so folding
        // changes the row count without changing what the block reads as.
        marker: BORDERS.THINKING.char,
        markerFg: T.reasoningAccent,
        label: 'thinking',
        labelFg: T.reasoningAccent,
        detailFg: '244',
      }, [
        { text: ` ${GLYPHS.navigation.collapsed} ${thinkingLineCount} line${thinkingLineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
      ], ''));
    } else {
      const thinkingLines = renderThinkingBlock(message.reasoningContent, width);
      context.history.addLines(thinkingLines);
    }
    context.history.addLine(createEmptyLine(width));
    const thinkingRenderedLines = context.history.getLineCount() - thinkingStartLine;
    context.blockRegistry.push({
      blockIndex: thinkingBlockIdx,
      collapseKey: thinkingCollapseKey,
      type: 'thinking',
      startLine: thinkingStartLine,
      lineCount: thinkingRenderedLines,
      rawContent: message.reasoningContent,
    });
  }
  if (showReasoningSummary && message.reasoningSummary) {
    const summaryLines = renderThinkingBlock(message.reasoningSummary, width);
    context.history.addLines(summaryLines);
    context.history.addLine(createEmptyLine(width));
  }

  if (message.content) renderAssistantProse(context, message, width, lineNumberMode, collapseThreshold, msgIdx);
}

/**
 * Assistant prose — the model's actual answer — at full prominence and full
 * width.
 *
 * Prose is never drawn as a tree branch. It is what closes a group (see
 * startsNewTurn) and the content the tree exists to surround, not a child of
 * it; indenting it would also re-wrap markdown at a reduced width, which is
 * the table-drops-columns hazard.
 */
function renderAssistantProse(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'assistant' }>,
  width: number,
  lineNumberMode: 'all' | 'code' | 'off',
  collapseThreshold: number,
  msgIdx: number,
): void {
  {
    const showAllLineNumbers = lineNumberMode === 'all';
    const showCodeBlockLineNumbers = lineNumberMode === 'all' ? false : lineNumberMode === 'code';
    // First pass: measure totalLines for gutter sizing (only when line-numbers='all').
    // When line numbers are off, skip the measurement pass entirely.
    //
    // NOTE: The 'all' mode intentionally calls renderMarkdownTracked twice:
    //   1. Measure pass: render at full `width` to get the total line count, which
    //      determines `numWidth` (digit count) and thus `gutterW` (gutter column width).
    //   2. Render pass: render at `width - gutterW` with the gutter factored in.
    //
    // Single-pass is not pursued here. It would require either a pessimistic
    // `numWidth=6` (fits 999,999 lines, but wastes 3-4 gutter columns on typical
    // messages) or rendering the numbered output into a scratch buffer and trimming.
    // Neither is clearly better than the current two-pass measurement approach.
    // The 4α commit message claim that this "eliminates double-parse when line
    // numbers are enabled" was inaccurate: 4α eliminated the legacy
    // `renderMarkdown()` duplicate used for code-block line-number mode ('code').
    // The 'all' mode double-call is a deliberate design choice and remains unchanged.
    const measureWidth = showAllLineNumbers ? width : 0;
    const totalLines = showAllLineNumbers
      ? renderMarkdownTracked(message.content, measureWidth, { codeBlockLineNumbers: false }).lines.length
      : 0;
    const numWidth = Math.max(3, String(totalLines).length);
    const gutterW = numWidth + 3;
    const contentWidth = showAllLineNumbers ? width - gutterW : width;
    const renderWidth = showAllLineNumbers ? contentWidth : width;

    const { lines: tracked, codeBlocks } = renderMarkdownTracked(message.content, renderWidth, {
      codeBlockLineNumbers: showCodeBlockLineNumbers,
    });

    const msgBaseLineOffset = context.history.getLineCount();
    for (const cb of codeBlocks) {
      const blockStartLine = msgBaseLineOffset + cb.startOffset;
      const blockIdx = context.blockRegistry.length;
      const collapseKey = `code_${msgIdx}_${blockIdx}`;
      const isAutoCollapsed = cb.rawContent.split('\n').length > collapseThreshold;
      if (isAutoCollapsed && !context.collapseState.has(collapseKey)) {
        context.collapseState.set(collapseKey, true);
      }
      context.blockRegistry.push({
        blockIndex: blockIdx,
        collapseKey,
        type: 'code',
        startLine: blockStartLine,
        lineCount: cb.lineCount,
        rawContent: cb.rawContent,
      });
    }

    if (showAllLineNumbers) {
      const numbered = tracked.map((line, i) => {
        const label = String(i + 1).padStart(numWidth) + ' │ ';
        const gutterCells = UIFactory.stringToLine(label, gutterW, { fg: '238', dim: true });
        const fullLine = createEmptyLine(width);
        for (let ci = 0; ci < gutterW && ci < gutterCells.length; ci++) {
          fullLine[ci] = gutterCells[ci];
        }
        for (let ci = 0; ci < line.length && gutterW + ci < width; ci++) {
          fullLine[gutterW + ci] = line[ci];
        }
        return fullLine;
      });
      context.history.addLines(numbered);
    } else {
      context.history.addLines(tracked);
    }
  }

}

export function renderConversationSystemMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'system' }>,
  width: number,
  msgIdx: number,
): void {
  const sysStartLine = context.history.getLineCount();
  const sysLines = renderSystemMessage(message.content, width);
  context.history.addLines(sysLines);
  // Resolve navigability from the stored kind, defaulting to 'system'
  // (navigable) for messages added without an explicit kind tag.
  const kind: SystemMessageKind = context.messageKindRegistry.get(msgIdx) ?? 'system';
  if (NAVIGABLE_KINDS.has(kind)) {
    context.errorLineRegistry.push(sysStartLine);
  }
}

/**
 * Render one tool-call row as a branch of its turn.
 *
 * The call row is its own plan node rather than part of the assistant
 * message's render, which is what lets a result be interleaved BETWEEN two
 * calls of the same message — the ordering guarantee that makes a
 * late-finishing call's result land inside its own subtree instead of after a
 * call issued later.
 */
export function renderConversationToolCallNode(
  context: ConversationRenderContext,
  node: RenderNode,
  width: number,
): void {
  const T = activeTheme();
  const message = node.message;
  if (message.role !== 'assistant') return;
  const call = message.toolCalls?.[node.callIndex ?? 0];
  if (!call) return;

  const turn = context.assistantTurns?.get(node.absIdx);
  if (isTurnCollapsed(turn, context.collapseState)) return;

  // The call row carries the call's OUTCOME, not merely whether it finished:
  // the result row below it no longer repeats a marker, so this glyph is the
  // only place a failed or cancelled tool says so in the status column.
  const outcome = call.id !== undefined ? context.toolCallOutcomes?.get(call.id) : undefined;
  const ran = context.completedToolCallIds === undefined
    || (call.id !== undefined && context.completedToolCallIds.has(call.id));
  const status: 'done' | 'error' | 'cancelled' | 'pending' = outcome === 'error'
    ? 'error'
    : outcome === 'cancelled'
      ? 'cancelled'
      : outcome === 'ok'
        ? 'done'
        : ran ? 'done' : 'pending';
  const indent = treeIndentCols(node.depth, width);
  const lines = renderToolCallBlock(
    call,
    status,
    undefined,
    width,
    undefined,
    undefined,
    undefined,
    undefined,
    { indentCols: indent, omitToolName: turn?.sharedToolLabel !== undefined },
  );

  // Recursion stopped here — say so rather than silently showing a subtree as
  // if it were a leaf.
  if (node.truncated) {
    const noteIndent = treeIndentCols(node.depth + 1, width);
    lines.push(renderConversationEventLine(width, {
      marker: GLYPHS.navigation.collapsed,
      markerFg: '244',
      label: '',
      labelFg: '244',
      detailFg: '244',
    }, [{
      text: node.truncated === 'depth'
        ? ` nested activity continues below depth ${MAX_NEST_DEPTH} `
        : ' nested activity repeats an agent already shown above ',
      fg: '244',
      dim: true,
    }], noteIndent));
  }

  // Rails last, over every line the row emitted, so the vertical run down to
  // the next sibling has no gap in it.
  drawTreeRails(lines, node.depth, node.connector, node.openAncestorDepths, width, T.toolAccent);
  context.history.addLines(lines);
}

/**
 * Move an already-rendered line `cols` columns to the right on a fresh
 * full-width line. Used to place a tree row's expanded body under its own
 * indent without re-rendering it at a different width (which would change the
 * line count the row's badge already committed to).
 */
function shiftLineRight(line: Line, cols: number, width: number): Line {
  if (cols <= 0) return line;
  const shifted = createEmptyLine(width);
  for (let i = 0; i < line.length; i++) {
    const target = i + cols;
    if (target >= width) break;
    shifted[target] = line[i]!;
  }
  return shifted;
}

export function renderConversationToolMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'tool' }>,
  width: number,
  msgIdx: number,
  node?: RenderNode,
): void {
  const T = activeTheme();
  const depth = node?.depth ?? 0;
  const indent = treeIndentCols(depth, width);
  const turn = context.assistantTurns?.get(msgIdx);
  // A collapsed turn hides its machinery; the head's prose stays visible.
  if (isTurnCollapsed(turn, context.collapseState)) return;

  const collapseKey = node ? collapseKeyForNode(node) : `msg_${msgIdx}`;
  const blockIdx = context.blockRegistry.length;
  const startLine = context.history.getLineCount();
  const contentLines = message.content.split('\n');
  const isDiff = isDiffContent(message.content);
  const blockType: 'diff' | 'tool' = isDiff ? 'diff' : 'tool';
  // Parsed once, ahead of the collapse check, so it's available for the
  // block-registry meta merge below regardless of collapsed/expanded state.
  const diffParse = isDiff ? parseDiffForApply(message.content) : undefined;
  const inTree = depth > 0 && indent > 0;
  // The EXPANDED render, computed unconditionally (even while collapsed) so
  // the header's "N lines" badge always names what Tab would actually reveal
  // — a raw JSON blob that pretty-prints to 50 lines must say 50, not 1, even
  // while it's still folded. Reused below as the actual body when expanded,
  // so this is never rendered twice.
  //
  // In the tree it is rendered at the width it will actually OCCUPY (the row's
  // width less its indent) and then shifted into place, so the badge still
  // counts exactly the lines expansion produces. Rendering it full-width and
  // displaying it indented would desynchronise the two — the
  // markdown-table-drops-columns bug class — and rendering it full-width and
  // displaying it flush punches the row's rails out for the whole body.
  // The body is a continuation of its row, so it starts at the row's own text
  // column; the shift is that column expressed relative to the flush left
  // margin the body renders with internally.
  const bodyShift = inTree ? Math.max(0, treeTextCol(indent) - LAYOUT.LEFT_MARGIN) : 0;
  const bodyWidth = Math.max(LAYOUT.LEFT_MARGIN + LAYOUT.RIGHT_MARGIN + 8, width - bodyShift);
  const expandedLines = renderExpandedToolResultLines(message.content, bodyWidth);
  const lineCount = expandedLines.length;

  // Human one-line summary for tool results (write/read/exec/edit): shown as the
  // collapsed line so the transcript reads "wrote foo.txt (532 B)" instead of a
  // raw JSON blob; the full payload stays behind the expand toggle. Only for
  // 'tool' blocks (diffs render their own view). (item 3.)
  const resultSummary = blockType === 'tool'
    ? summarizeToolResult(message.toolName, message.content)
    : null;

  const isCollapsed = isToolResultFolded(message, context.collapseState, collapseKey);

  // The fold decision IS the stored default: with nothing stored,
  // isToolResultFolded() already resolved to exactly the value this key should
  // hold. Recomputing "is it short?" here would be a second copy of the
  // threshold that the policy module owns.
  if (!context.collapseState.has(collapseKey)) {
    context.collapseState.set(collapseKey, isCollapsed);
  }

  // A per-call user cancellation settles as a tool result whose content leads
  // with "Error: cancelled by user" (the SDK's structured cancelled shape; any
  // partial output the tool produced before it stopped follows on later lines).
  // Render it structurally as a distinct "cancelled" block in the warn tone —
  // not a generic tool result, and not a hard error — so the transcript reads
  // the user's decision honestly while the partial output stays visible below.
  const isCancelled = blockType === 'tool' && /^Error: cancelled by user\b/.test(contentLines[0] ?? '');
  const warnTone = activeUiTones().chrome.warn;

  // In the tree a result hangs under the call that produced it, so repeating
  // the generic label ("tool result") and the tool's own name — which the
  // parent call row already shows — is exactly the boilerplate this layout
  // removes. The row leads with its size badge instead. `diff` and `cancelled`
  // keep their labels: those carry information the parent row does not.
  const label = isCancelled ? 'cancelled' : (blockType === 'diff' ? 'diff' : (inTree ? '' : 'tool result'));
  const nameSegments = inTree
    ? []
    : (message.toolName
      ? [{ text: ` ${message.toolName} `, fg: T.toolNameFg }]
      : [{ text: ` ${summarizeCallId(message.callId || 'standalone')} `, fg: '244' as const, dim: true }]);

  // A FOLDED result is exactly one row: this header, with its preview riding on
  // the same line right after the `▸ N lines` badge (see
  // renderConversationFoldedRow). The badge is the count — the old fold also
  // carried a separate `[▸ N hidden]` marker, which restated it.
  const headerTone = {
    marker: isCancelled ? GLYPHS.status.blocked : (blockType === 'diff' ? GLYPHS.status.dualPane : GLYPHS.status.active),
    markerFg: isCancelled ? warnTone : (blockType === 'diff' ? T.diffAccent : T.toolAccent),
    label,
    labelFg: isCancelled ? warnTone : (blockType === 'diff' ? T.diffAccent : T.toolAccent),
    detailFg: '244',
  };
  const headerDetails = [
    ...nameSegments,
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${lineCount} line${lineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
  ];
  const headerLine = isCollapsed
    ? renderConversationFoldedRow(width, headerTone, headerDetails, resultSummary ?? contentLines[0] ?? '', indent)
    : renderConversationEventLine(width, headerTone, headerDetails, indent);
  // Every line this row emits, gathered before anything is committed, so the
  // rails can be drawn across all of them in one pass (see drawTreeRails). The
  // result row deliberately carries NO status marker of its own: the call row
  // directly above it already states the outcome in the shared bullet column,
  // and a second marker one row down only doubles it.
  const rows: Line[] = [headerLine];

  if (!isCollapsed) {
    // Diff or plain result — either way this is exactly `expandedLines`,
    // already computed above (and already what the header's line count is
    // honest about), so there is nothing left to render here.
    //
    // Deliberately NOT indented. renderExpandedToolResultLines is the single
    // source of truth for the "N lines" badge above; re-wrapping it at a
    // reduced width would desynchronise that count from what expansion
    // actually reveals — the markdown-table-drops-columns bug class. The body
    // is already visually bound to its row by the header directly above it.
    // In the tree it was rendered at `bodyWidth` above and is shifted into the
    // row's indent here, which is what leaves the rail columns to its left free
    // for the rails to run through.
    for (const line of expandedLines) rows.push(shiftLineRight(line, bodyShift, width));
  }

  if (node && inTree) {
    drawTreeRails(rows, node.depth, node.connector, node.openAncestorDepths, width, T.toolAccent);
  }
  context.history.addLines(rows);

  const renderedLineCount = context.history.getLineCount() - startLine;
  let meta: BlockMeta = {
    blockIndex: blockIdx,
    collapseKey,
    type: blockType,
    startLine,
    lineCount: renderedLineCount,
    rawContent: message.content,
    toolName: message.toolName,
  };

  if (isDiff && diffParse) {
    meta = { ...meta, ...diffParse };
  }

  context.blockRegistry.push(meta);
}

export function appendConversationMessages(
  context: ConversationRenderContext,
  messages: Message[],
  width: number,
  messageLineRegistry: number[],
  /**
   * Absolute index of messages[0] in the full (unsliced) conversation snapshot.
   * Required to align slice-relative loop indices with the absolute keys stored
   * in messageKindRegistry, which is keyed at add-time (before any slice).
   * Defaults to 0 when the full snapshot is rendered (no clearDisplay in effect).
   */
  msgIndexOffset = 0,
): void {
  const lineNumberMode = context.configManager?.get('display.lineNumbers') ?? 'off';
  const collapseThreshold = context.configManager?.get('display.collapseThreshold') ?? 30;
  // Derive pending vs done for tool calls from sibling tool-result messages,
  // unless the caller already supplied the set. (item 2c.)
  const renderContext: ConversationRenderContext = context.completedToolCallIds !== undefined
    ? context
    : (() => {
      const toolCallOutcomes = collectToolCallOutcomes(messages);
      return { ...context, toolCallOutcomes, completedToolCallIds: new Set(toolCallOutcomes.keys()) };
    })();
  const assistantTurns = renderContext.assistantTurns
    ?? computeAssistantTurns(messages, msgIndexOffset);
  const turnContext: ConversationRenderContext = renderContext.assistantTurns !== undefined
    ? renderContext
    : { ...renderContext, assistantTurns };

  const plan = buildRenderPlan(messages, msgIndexOffset, {
    resolveAgentSnapshot: context.resolveAgentSnapshot,
  });

  // Header line of each turn, so a row that renders nothing (hidden by a
  // collapsed turn) still anchors transcript navigation at its turn rather
  // than at whatever position the buffer happens to sit at.
  const turnHeaderLines = new Map<string, number>();

  for (let i = 0; i < plan.length; i++) {
    const node = plan[i]!;
    const before = turnContext.history.getLineCount();

    if (node.kind === 'toolcall') {
      renderConversationToolCallNode(turnContext, node, width);
    } else {
      const message = node.message;
      // Nested rows index into their own agent's snapshot, so they must not
      // write the root transcript's line registry.
      const isRoot = node.scope === '';
      const turn = turnContext.assistantTurns?.get(node.absIdx);
      if (turn?.isHead) turnHeaderLines.set(turn.turnKey, before);
      if (isRoot) {
        messageLineRegistry[node.absIdx] = turn && isTurnCollapsed(turn, turnContext.collapseState)
          ? (turnHeaderLines.get(turn.turnKey) ?? before)
          : before;
      }

      if (message.role === 'user') {
        renderConversationUserMessage(turnContext, message, width, node.absIdx);
      } else if (message.role === 'assistant') {
        renderConversationAssistantMessage(turnContext, message, width, lineNumberMode, collapseThreshold, node.absIdx);
      } else if (message.role === 'system') {
        renderConversationSystemMessage(turnContext, message, width, node.absIdx);
      } else if (message.role === 'tool') {
        renderConversationToolMessage(turnContext, message, width, node.absIdx, node);
      }
    }

    const rendered = turnContext.history.getLineCount() > before;
    if (!rendered) continue;
    // Branch rows sit tight under their parent; the blank separator lands only
    // after the last row of a top-level unit, which is what keeps a turn's
    // whole subtree reading as one block instead of a run of spaced-out rows.
    // A folded result followed by more tool machinery gets no blank at all —
    // consecutive folded results stack as adjacent single rows.
    if (trailingBlankAfter(node, plan[i + 1], turnContext)) {
      turnContext.history.addLine(createEmptyLine(width));
    }
  }
}

export function addConversationSplashScreen(
  context: ConversationRenderContext,
  width: number,
): void {
  const splashStrings = getSplashLines(width, context.splashOptions);
  const cyan = '#00ffff';
  const purple = '#d000ff';
  const grey = '244';

  splashStrings.forEach((str, y) => {
    const line = UIFactory.stringToLine(str, width);
    const isVersion = y === splashStrings.length - 1;
    const startX = Math.floor((width - getDisplayWidth(str)) / 2);
    const endX = startX + getDisplayWidth(str);

    for (let x = 0; x < width; x++) {
      const cell = line[x];
      if (cell.char === ' ' && (x < startX || x >= endX)) continue;
      if (isVersion) {
        cell.fg = grey;
        cell.dim = true;
      } else {
        const factor = (x - startX) / (endX - startX || 1);
        cell.fg = interpolateColor(cyan, purple, Math.max(0, Math.min(1, factor)));
        cell.bold = true;
      }
    }
    context.history.addLine(line);
  });
  for (let i = 0; i < 5; i++) {
    context.history.addLine(createEmptyLine(width));
  }
}

export function conversationTextToLines(
  text: string,
  width: number,
  style: Partial<Cell> = {},
): Line[] {
  const contentWidth = LAYOUT.contentWidth(width);
  const wrapped = wrapText(text, contentWidth);
  return wrapped.map((line, index) => {
    const prefix = index === 0 ? '>' + ' '.repeat(LAYOUT.LEFT_MARGIN - 1) : ' '.repeat(LAYOUT.LEFT_MARGIN);
    return UIFactory.stringToLine(prefix + line, width, style);
  });
}

export function logConversationText(
  context: Pick<ConversationRenderContext, 'history'>,
  width: number,
  text: string,
  style: Partial<Cell> = {},
  indent = ' '.repeat(LAYOUT.LEFT_MARGIN),
): void {
  const lines = text.split('\n').map((line) => UIFactory.stringToLine(indent + line, width, style));
  context.history.addLines(lines);
}

/**
 * logConversationToolResult - Append a single tool-call-style result line to the
 * display history only, reusing renderToolCallBlock so a display-only render (e.g.
 * a slash command's subprocess result) is visually indistinguishable from the
 * model's own tool-call results. Display-only: never touches message history.
 */
export function logConversationToolResult(
  context: Pick<ConversationRenderContext, 'history'>,
  width: number,
  toolCall: ToolCall,
  status: 'done' | 'error',
  resultSummary: string,
  durationMs: number,
  errorMsg?: string,
): void {
  context.history.addLines(renderToolCallBlock(toolCall, status, resultSummary, width, durationMs, errorMsg));
}
