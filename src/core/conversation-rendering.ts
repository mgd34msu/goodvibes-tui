import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderDiffView } from '../renderer/diff-view.ts';
import { activeTheme, activeUiTones } from '../renderer/theme.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { summarizeToolResult } from '../renderer/tool-result-summary.ts';
import type { ToolCall } from '@pellux/goodvibes-sdk/platform/types';
import { renderThinkingBlock } from '../renderer/thinking.ts';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { LAYOUT } from '../renderer/layout.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { renderConversationCollapsedFragment, renderConversationEventLine } from '../renderer/conversation-surface.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import type { BlockMeta } from './conversation-types.ts';
import { computeToolGroupMembership, type ToolGroupMembership } from './conversation-tool-groups.ts';
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

/**
 * Collect the ids of tool calls that have a matching tool-result message in the
 * given slice — i.e. the tools that actually ran. Used to decide whether an
 * assistant tool call still shows as pending (awaiting approval) or done.
 * (item 2c.)
 */
export function collectCompletedToolCallIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.callId) ids.add(message.callId);
  }
  return ids;
}

function summarizeCallId(callId: string, maxLength = 24): string {
  return callId.length <= maxLength ? callId : `${callId.slice(0, maxLength - 1)}…`;
}

export interface ConversationRenderContext {
  readonly history: {
    addLine: (line: Line) => void;
    addLines: (lines: Line[]) => void;
    getLineCount: () => number;
  };
  readonly blockRegistry: BlockMeta[];
  readonly collapseState: Map<string, boolean>;
  readonly errorLineRegistry: number[];
  /** Maps message index → SystemMessageKind for typed system messages. */
  readonly messageKindRegistry: ReadonlyMap<number, SystemMessageKind>;
  readonly configManager: ConfigManager | null;
  readonly splashOptions: SplashOptions;
  /**
   * Tool-call ids that have a corresponding tool-result message (i.e. the tool
   * actually ran). An assistant tool call whose id is NOT in this set is still
   * awaiting a decision (e.g. an approval prompt) and renders with a pending
   * glyph instead of the completed ✓. When undefined (single-message callers
   * without sibling context), every tool call renders as done — the prior
   * behaviour. (item 2c.)
   */
  readonly completedToolCallIds?: ReadonlySet<string>;
  /**
   * Per-tool-message group membership for the currently rendered slice (see
   * conversation-tool-groups.ts). A message index absent from this map (or an
   * undefined map itself) isn't part of a folded run of tool results and
   * renders exactly as it always has.
   */
  readonly toolGroupMembership?: ReadonlyMap<number, ToolGroupMembership>;
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

/** Fold a compaction-continuation user message to one header + preview line. */
function renderCompactionContinuationMessage(
  context: ConversationRenderContext,
  content: string,
  width: number,
  msgIdx: number,
): void {
  const T = activeTheme();
  const collapseKey = `msg_${msgIdx}`;
  const blockIdx = context.blockRegistry.length;
  const startLine = context.history.getLineCount();
  const lineCount = content.split('\n').length;
  const isCollapsed = context.collapseState.has(collapseKey)
    ? context.collapseState.get(collapseKey)!
    : true;
  if (!context.collapseState.has(collapseKey)) {
    context.collapseState.set(collapseKey, true);
  }

  context.history.addLine(renderConversationEventLine(width, {
    marker: GLYPHS.status.active,
    markerFg: T.toolAccent,
    label: 'compaction handoff',
    labelFg: T.toolAccent,
    detailFg: '244',
  }, [
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${lineCount} line${lineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
  ]));

  if (isCollapsed) {
    const rendered = renderConversationCollapsedFragment(
      'compacted-context handoff (re-injected instructions + session summary)',
      width,
      {
        prefix: ` ${GLYPHS.navigation.collapsed} `,
        prefixFg: T.toolAccent,
        text: '244',
        bodyBg: T.collapsedBodyBg,
        dim: true,
      },
    );
    context.history.addLines(rendered);
  } else {
    context.history.addLines(renderMarkdownTracked(content, width).lines);
  }

  context.blockRegistry.push({
    blockIndex: blockIdx,
    collapseKey,
    type: 'tool',
    startLine,
    lineCount: context.history.getLineCount() - startLine,
    rawContent: content,
  });
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
  const assistantHeaderDetails = [];
  if (message.model) {
    assistantHeaderDetails.push({ text: ` ${message.model}${message.provider ? ` (${message.provider})` : ''} `, fg: T.modelNameDim, dim: true });
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    assistantHeaderDetails.push({ text: ` ${GLYPHS.status.pending} tools:${message.toolCalls.length} `, fg: T.toolAccent });
  }
  if (message.reasoningContent || message.reasoningSummary) {
    assistantHeaderDetails.push({ text: ` ${GLYPHS.status.active} reasoning `, fg: T.reasoningAccent, dim: true });
  }
  if (assistantHeaderDetails.length > 0) {
    context.history.addLine(renderConversationEventLine(width, {
      marker: GLYPHS.status.active,
      markerFg: T.assistantHeader,
      label: 'assistant',
      labelFg: T.assistantHeader,
      detailFg: '244',
    }, assistantHeaderDetails));
  }

  const showThinking = context.configManager?.get('display.showThinking') ?? false;
  const showReasoningSummary = context.configManager?.get('display.showReasoningSummary') ?? false;
  if (showThinking && message.reasoningContent) {
    const thinkingStartLine = context.history.getLineCount();
    const thinkingBlockIdx = context.blockRegistry.length;
    const thinkingCollapseKey = `msg_${msgIdx}_thinking`;
    const thinkingLines = renderThinkingBlock(message.reasoningContent, width);
    context.history.addLines(thinkingLines);
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

  if (message.content) {
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

  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const tc of message.toolCalls) {
      // A tool call with no result message yet is still awaiting a decision
      // (e.g. approval) — show a pending glyph, not the completed ✓.
      const ran = context.completedToolCallIds === undefined
        || (tc.id !== undefined && context.completedToolCallIds.has(tc.id));
      context.history.addLines(renderToolCallBlock(tc, ran ? 'done' : 'pending', undefined, width));
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
 * True when `message` is a non-owning member of a folded tool-result group
 * (see conversation-tool-groups.ts) that is currently collapsed — it rendered
 * nothing (renderConversationToolMessage returns right after the header-owning
 * member's header line), so the per-message trailing blank-line separator is
 * skipped for it too. The header-owning ("first") member always gets its
 * separator since it always renders at least the header line; any member of
 * an EXPANDED group renders in full and keeps its separator as well.
 */
export function isFoldedGroupMember(
  membership: ToolGroupMembership | undefined,
  collapseState: ReadonlyMap<string, boolean>,
): boolean {
  return membership !== undefined && !membership.isFirst && (collapseState.get(membership.groupKey) ?? true);
}

/**
 * Render the synthetic header line for a folded run of >=2 tool-result
 * messages: one line + one BlockMeta (type 'tool_group'), shared by every
 * member under `membership.groupKey`. Returns whether the group is currently
 * collapsed, establishing the collapsed-by-default state on first render —
 * mirrors the has/set default-establishment idiom used by every other
 * collapsible block in this file.
 */
function renderToolGroupHeader(
  context: ConversationRenderContext,
  width: number,
  membership: ToolGroupMembership,
): boolean {
  const T = activeTheme();
  const isCollapsed = context.collapseState.has(membership.groupKey)
    ? context.collapseState.get(membership.groupKey)!
    : true;
  if (!context.collapseState.has(membership.groupKey)) {
    context.collapseState.set(membership.groupKey, true);
  }

  const blockIdx = context.blockRegistry.length;
  const startLine = context.history.getLineCount();
  context.history.addLine(renderConversationEventLine(width, {
    marker: GLYPHS.surface.altCursor,
    markerFg: T.toolAccent,
    label: 'tool results',
    labelFg: T.toolAccent,
    detailFg: '244',
  }, [
    { text: ` ${membership.toolCount} tool${membership.toolCount === 1 ? '' : 's'} `, fg: T.toolAccent },
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${membership.totalLines} line${membership.totalLines === 1 ? '' : 's'} `, fg: '244', dim: true },
  ]));

  context.blockRegistry.push({
    blockIndex: blockIdx,
    collapseKey: membership.groupKey,
    type: 'tool_group',
    startLine,
    lineCount: 1,
    rawContent: `${membership.toolCount} tool result${membership.toolCount === 1 ? '' : 's'} folded (${membership.totalLines} line${membership.totalLines === 1 ? '' : 's'} total)`,
    groupMemberIndexes: membership.memberIndexes,
  });

  return isCollapsed;
}

export function renderConversationToolMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'tool' }>,
  width: number,
  msgIdx: number,
): void {
  const T = activeTheme();
  const groupMembership = context.toolGroupMembership?.get(msgIdx);
  if (groupMembership) {
    const collapsed = groupMembership.isFirst
      ? renderToolGroupHeader(context, width, groupMembership)
      : (context.collapseState.get(groupMembership.groupKey) ?? true);
    // Folded: the header (rendered above, once, by the first member) is the
    // group's entire visible representation while collapsed — no member,
    // first or not, renders its own header/body/BlockMeta.
    if (collapsed) return;
  }

  const collapseKey = `msg_${msgIdx}`;
  const blockIdx = context.blockRegistry.length;
  const startLine = context.history.getLineCount();
  const contentLines = message.content.split('\n');
  const lineCount = contentLines.length;
  const hasDiffHeader = contentLines.some((l) => l.startsWith('--- ')) && contentLines.some((l) => l.startsWith('+++ '));
  const hasHunk = contentLines.some((l) => l.startsWith('@@ '));
  const isDiff = hasDiffHeader && hasHunk;
  const blockType: 'diff' | 'tool' = isDiff ? 'diff' : 'tool';
  // Parsed once, ahead of the collapse check, so it's available for the
  // block-registry meta merge below regardless of collapsed/expanded state.
  const diffParse = isDiff ? parseDiffForApply(message.content) : undefined;

  // Human one-line summary for tool results (write/read/exec/edit): shown as the
  // collapsed line so the transcript reads "wrote foo.txt (532 B)" instead of a
  // raw JSON blob; the full payload stays behind the expand toggle. Only for
  // 'tool' blocks (diffs render their own view). (item 3.)
  const resultSummary = blockType === 'tool'
    ? summarizeToolResult(message.toolName, message.content)
    : null;

  // A summarizable result is kept collapsed-by-default even when short, so the
  // one-line summary wins and the raw JSON is tucked behind the expand toggle.
  const isShort = message.content.length <= 200 && resultSummary === null;
  const isCollapsed = isShort
    ? false
    : context.collapseState.has(collapseKey)
      ? context.collapseState.get(collapseKey)!
      : true;

  if (!context.collapseState.has(collapseKey)) {
    context.collapseState.set(collapseKey, isShort ? false : true);
  }

  // A per-call user cancellation settles as a tool result whose content leads
  // with "Error: cancelled by user" (the SDK's structured cancelled shape; any
  // partial output the tool produced before it stopped follows on later lines).
  // Render it structurally as a distinct "cancelled" block in the warn tone —
  // not a generic tool result, and not a hard error — so the transcript reads
  // the user's decision honestly while the partial output stays visible below.
  const isCancelled = blockType === 'tool' && /^Error: cancelled by user\b/.test(contentLines[0] ?? '');
  const warnTone = activeUiTones().chrome.warn;

  context.history.addLine(renderConversationEventLine(width, {
    marker: isCancelled ? GLYPHS.status.blocked : (blockType === 'diff' ? GLYPHS.status.dualPane : GLYPHS.status.active),
    markerFg: isCancelled ? warnTone : (blockType === 'diff' ? T.diffAccent : T.toolAccent),
    label: isCancelled ? 'cancelled' : (blockType === 'diff' ? 'diff' : 'tool result'),
    labelFg: isCancelled ? warnTone : (blockType === 'diff' ? T.diffAccent : T.toolAccent),
    detailFg: '244',
  }, [
    ...(message.toolName
      ? [{ text: ` ${message.toolName} `, fg: T.toolNameFg }]
      : [{ text: ` ${summarizeCallId(message.callId || 'standalone')} `, fg: '244' as const, dim: true }]),
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${lineCount} line${lineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
  ]));

  if (isCollapsed) {
    const collapseSuffixReserve = 30;
    const avail = Math.max(0, width - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN - collapseSuffixReserve);
    const hiddenCount = lineCount - 1;
    let collapsedText: string;
    if (resultSummary !== null) {
      // Summary line — the header already shows "▸ N lines", so no hidden badge.
      collapsedText = resultSummary.length > avail
        ? `${resultSummary.slice(0, Math.max(0, avail - 1))}…`
        : resultSummary;
    } else {
      const preview = contentLines[0].slice(0, avail);
      collapsedText = hiddenCount > 0
        ? `${preview}...  [${GLYPHS.navigation.collapsed} ${hiddenCount} hidden]`
        : preview;
    }
    const rendered = renderConversationCollapsedFragment(collapsedText, width, {
      prefix: blockType === 'diff' ? ` ${GLYPHS.status.dualPane} ` : ` ${GLYPHS.navigation.collapsed} `,
      prefixFg: blockType === 'diff' ? T.diffAccent : T.toolAccent,
      text: '244',
      bodyBg: T.collapsedBodyBg,
      dim: true,
    });
    context.history.addLines(rendered);
  } else if (isDiff) {
    // No filename banner: the diff text's own --- / +++ headers already
    // identify the file (matches the pre-v0.9.6 call site in tool-call.ts).
    context.history.addLines(renderDiffView(message.content, width));
  } else {
    let contentToRender = message.content;
    const trimmed = contentToRender.trimStart();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && contentToRender.length < 100_000) {
      try {
        const parsed = JSON.parse(contentToRender);
        contentToRender = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
      } catch {
        // Leave invalid JSON as-is.
      }
    }
    context.history.addLines(renderMarkdownTracked(contentToRender, width).lines);
  }

  const renderedLineCount = context.history.getLineCount() - startLine;
  let meta: BlockMeta = {
    blockIndex: blockIdx,
    collapseKey,
    type: blockType,
    startLine,
    lineCount: renderedLineCount,
    rawContent: message.content,
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
    : { ...context, completedToolCallIds: collectCompletedToolCallIds(messages) };
  // Fold runs of >=2 consecutive tool-result messages sharing one assistant
  // turn under a single collapsible header (see conversation-tool-groups.ts),
  // unless the caller already supplied membership (the line-cache path
  // computes it once per renderInto call and threads it through).
  const toolGroupMembership = renderContext.toolGroupMembership
    ?? computeToolGroupMembership(messages, msgIndexOffset);
  const groupedContext: ConversationRenderContext = renderContext.toolGroupMembership !== undefined
    ? renderContext
    : { ...renderContext, toolGroupMembership };

  // Header line of each currently-open tool-group, keyed by groupKey — the
  // first member's own registered line, recorded as that member is reached
  // below so later (non-first) members of the SAME group can resolve to it
  // instead of whatever position the buffer happens to be at when a folded
  // (zero-line) member is processed. See isFoldedGroupMember's doc.
  const groupHeaderLines = new Map<string, number>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const message = messages[msgIdx];
    // absoluteIdx aligns the slice-relative loop counter with the absolute
    // message index used as the key in messageKindRegistry and messageLineRegistry.
    const absoluteIdx = msgIndexOffset + msgIdx;
    const membership = toolGroupMembership.get(absoluteIdx);
    const currentLine = groupedContext.history.getLineCount();
    if (membership?.isFirst) groupHeaderLines.set(membership.groupKey, currentLine);
    // A folded (non-first, currently collapsed) group member renders zero
    // lines of its own — `currentLine` here is just wherever the buffer
    // happens to sit after the last member that DID render, which is the
    // position the NEXT real content starts at, not this message's own
    // position. Anchor it at the group's header line instead, so
    // transcript-event navigation lands on the group rather than skipping
    // past it to the following message.
    messageLineRegistry[absoluteIdx] = isFoldedGroupMember(membership, groupedContext.collapseState)
      ? (groupHeaderLines.get(membership!.groupKey) ?? currentLine)
      : currentLine;
    if (message.role === 'user') {
      renderConversationUserMessage(groupedContext, message, width, absoluteIdx);
    } else if (message.role === 'assistant') {
      renderConversationAssistantMessage(groupedContext, message, width, lineNumberMode, collapseThreshold, absoluteIdx);
    } else if (message.role === 'system') {
      renderConversationSystemMessage(groupedContext, message, width, absoluteIdx);
    } else if (message.role === 'tool') {
      renderConversationToolMessage(groupedContext, message, width, absoluteIdx);
    }
    if (!isFoldedGroupMember(membership, groupedContext.collapseState)) {
      groupedContext.history.addLine(createEmptyLine(width));
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
