import { UIFactory } from '../renderer/ui-factory.ts';
import { activeTheme, activeTokens } from '../renderer/theme.ts';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { createEmptyLine, type Line, type Cell } from '@pellux/goodvibes-sdk/platform/types';
import { getSplashLines, SPLASH_GRADIENT } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { LAYOUT } from '../renderer/layout.ts';
import type { ConversationRenderContext } from './conversation-render-context.ts';
import { renderCompactionContinuationMessage } from './conversation-compaction-render.ts';
import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { extractUserDisplayText, COMPACTION_HANDOFF_HEADER } from '@pellux/goodvibes-sdk/platform/core';
import { laneGlyphs } from '../renderer/lane-graph/glyphs.ts';
import { beadArgument, beadName, cellText, formatBeadTime } from '../renderer/lane-graph/bead.ts';
import { paintBeadRow } from '../renderer/lane-graph/paint.ts';
import { buildTurnModel, orphanResultBead, transcriptUnits, type TranscriptUnit, type TurnModel } from './work-tree-model.ts';
import { renderSingleBead, renderTurn, type TurnRender } from './work-tree-render.ts';
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
 *   - 'system'      YES, generic/catch-all messages (provider failures, session
 *                         events, user-visible errors). Default for un-prefixed messages.
 *   - 'wrfc'        YES, WRFC chain events are important and worth navigating to.
 *   - 'operational' NO , tool/scan/plugin/MCP status noise; not useful to jump to.
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
  type ConversationRenderContext,
  type ToolCallOutcome,
} from './conversation-render-context.ts';

/** Whether a system message at `msgIdx` is navigable for error navigation. */
export function isNavigableSystemMessage(context: Pick<ConversationRenderContext, 'messageKindRegistry'>, msgIdx: number): boolean {
  return NAVIGABLE_KINDS.has(context.messageKindRegistry.get(msgIdx) ?? 'system');
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
    context.history.addLines(UIFactory.createMessageBar(width, displayText, T.errorBarBg, activeTokens().textMuted, activeTokens().error, true));
    return;
  }
  // Compaction-continuation handoff: a user-ROLE message the compactor
  // authored, not something the user typed. Rendered in full it repeats the
  // entire re-injected instruction block after every automatic compaction,
  // a multi-kilobyte wall in the transcript. Fold it like a tool result; the
  // full payload stays reachable through the normal expand toggle.
  if (msgIdx !== undefined && displayText.startsWith(COMPACTION_HANDOFF_HEADER)) {
    renderCompactionContinuationMessage(context, displayText, width, msgIdx);
    return;
  }
  context.history.addLines(UIFactory.createMessageBar(width, displayText));
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

/** Build one assistant turn's work-tree model from the render context. */
export function buildConversationTurnModel(
  context: ConversationRenderContext,
  messages: readonly Message[],
  offset: number,
  unit: Extract<TranscriptUnit, { kind: 'turn' }>,
  streamingIndex = -1,
): TurnModel {
  const config = context.configManager;
  return buildTurnModel({
    messages,
    offset,
    unit,
    sources: context.workTreeSources ?? {},
    collapse: context.collapseState,
    streamingIndex,
    showThinking: config?.get('display.showThinking') ?? false,
    showReasoningSummary: config?.get('display.showReasoningSummary') ?? false,
  });
}

/** Draw a turn model (lines, blocks and error lines relative to the turn). */
export function drawConversationTurn(context: ConversationRenderContext, model: TurnModel, width: number): TurnRender {
  const config = context.configManager;
  return renderTurn(model, {
    width,
    glyphSet: context.treeGlyphSet ?? 'rounded',
    focusId: context.focusId ?? null,
    lineNumberMode: config?.get('display.lineNumbers') ?? 'off',
    collapseThreshold: config?.get('display.collapseThreshold') ?? 30,
    collapseState: context.collapseState,
    isNavigableSystem: (index) => isNavigableSystemMessage(context, index),
    frame: context.frame ?? 0,
  });
}

/**
 * Render one assistant turn through the work tree (work-tree-model.ts builds
 * its rows, work-tree-render.ts draws them) into the context's history.
 */
export function renderConversationTurn(
  context: ConversationRenderContext,
  messages: readonly Message[],
  offset: number,
  unit: Extract<TranscriptUnit, { kind: 'turn' }>,
  width: number,
  streamingIndex = -1,
): TurnRender {
  const render = drawConversationTurn(context, buildConversationTurnModel(context, messages, offset, unit, streamingIndex), width);
  const base = context.history.getLineCount();
  const blockBase = context.blockRegistry.length;
  context.history.addLines(render.lines);
  for (const block of render.blocks) {
    context.blockRegistry.push({ ...block, blockIndex: block.blockIndex + blockBase, startLine: block.startLine + base });
  }
  for (const line of render.errorLines) context.errorLineRegistry.push(line + base);
  return render;
}

/**
 * Render a message slice: user and system messages as themselves, every
 * assistant turn as its work tree, a blank row after each unit.
 */
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
  for (const unit of transcriptUnits(messages, msgIndexOffset)) {
    const before = context.history.getLineCount();
    if (unit.kind === 'turn') {
      const render = renderConversationTurn(context, messages, msgIndexOffset, unit, width);
      for (const [index, line] of render.messageLines) messageLineRegistry[index] = before + line;
      for (let index = unit.start; index <= unit.end; index++) messageLineRegistry[index] ??= before;
    } else {
      messageLineRegistry[unit.index] = before;
      renderConversationMessageUnit(context, messages[unit.index - msgIndexOffset]!, width, unit.index);
    }
    if (context.history.getLineCount() > before) context.history.addLine(createEmptyLine(width));
  }
}

/** A standalone message unit (a user message, or a system message outside any turn). */
export function renderConversationMessageUnit(
  context: ConversationRenderContext,
  message: Message,
  width: number,
  msgIdx: number,
): void {
  if (message.role === 'user') renderConversationUserMessage(context, message, width, msgIdx);
  else if (message.role === 'system') renderConversationSystemMessage(context, message, width, msgIdx);
  else if (message.role === 'tool') {
    // A result whose call is outside the rendered slice (the display was
    // cleared mid-turn): one bead of its own, with its block and body.
    const render = renderSingleBead(orphanResultBead(message, msgIdx, context.collapseState), {
      width,
      glyphSet: context.treeGlyphSet ?? 'rounded',
      focusId: context.focusId ?? null,
      lineNumberMode: 'off',
      collapseThreshold: 30,
      collapseState: context.collapseState,
      isNavigableSystem: () => false,
      frame: context.frame ?? 0,
    });
    const base = context.history.getLineCount();
    const blockBase = context.blockRegistry.length;
    context.history.addLines(render.lines);
    for (const block of render.blocks) context.blockRegistry.push({ ...block, blockIndex: blockBase + block.blockIndex, startLine: base + block.startLine });
  }
}

export function addConversationSplashScreen(
  context: ConversationRenderContext,
  width: number,
): void {
  const splashStrings = getSplashLines(width, context.splashOptions);
  // The splash gradient is protected: it never follows the theme.
  const { start: cyan, end: purple } = SPLASH_GRADIENT;
  const versionFg = activeTokens().textFaint;

  splashStrings.forEach((str, y) => {
    const line = UIFactory.stringToLine(str, width);
    const isVersion = y === splashStrings.length - 1;
    const startX = Math.floor((width - getDisplayWidth(str)) / 2);
    const endX = startX + getDisplayWidth(str);

    for (let x = 0; x < width; x++) {
      const cell = line[x];
      if (cell.char === ' ' && (x < startX || x >= endX)) continue;
      if (isVersion) {
        cell.fg = versionFg;
      } else {
        const factor = (x - startX) / (endX - startX || 1);
        cell.fg = interpolateColor(cyan, purple, Math.max(0, Math.min(1, factor)));
        cell.bold = true;
      }
    }
    context.history.addLine(line);
  });
  // No trailing blank rows: the shell centers the splash in whatever height
  // the conversation area has (conversation-layout.ts centerViewportContent).
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
 * logConversationToolResult - Append a display-only tool result (a slash
 * command's subprocess result, e.g. /test) as one bead row, the same row a
 * model's own call draws in the work tree. Never touches message history.
 */
export function logConversationToolResult(
  context: Pick<ConversationRenderContext, 'history' | 'treeGlyphSet'>,
  width: number,
  toolCall: ToolCall,
  status: 'done' | 'error',
  resultSummary: string,
  durationMs: number,
  errorMsg?: string,
): void {
  renderStandaloneBead(context, width, toolCall, status, errorMsg ? `${resultSummary ? `${resultSummary} · ` : ''}${errorMsg}` : resultSummary, durationMs);
}

function renderStandaloneBead(
  context: Pick<ConversationRenderContext, 'history' | 'treeGlyphSet'>,
  width: number,
  toolCall: ToolCall,
  status: 'done' | 'error',
  summary: string,
  durationMs: number | undefined,
): void {
  const glyphs = laneGlyphs(context.treeGlyphSet ?? 'rounded');
  context.history.addLine(paintBeadRow([{ role: 'bead', color: 0 }], {
    status: status === 'error' ? 'err' : 'ok',
    name: beadName(toolCall),
    arg: beadArgument(toolCall),
    summary: summary ? { text: cellText(summary), tone: status === 'error' ? 'bad' : 'faint' } : null,
    time: durationMs !== undefined ? formatBeadTime(durationMs) : undefined,
    laneColor: activeTokens().brand,
    hasBody: false,
    open: false,
  }, { width, gutterWidth: 6, glyphs, frame: 0 }));
}
