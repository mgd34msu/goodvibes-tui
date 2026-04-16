import { UIFactory } from '../renderer/ui-factory.ts';
import { renderMarkdown, renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderToolCallBlock } from '../renderer/tool-call.ts';
import { renderThinkingBlock } from '../renderer/thinking.ts';
import { renderSystemMessage } from '../renderer/system-message.ts';
import { createEmptyLine, type Line, type Cell } from '../types/grid.ts';
import { getSplashLines, type SplashOptions } from '../utils/splash-lines.ts';
import { interpolateColor, getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { LAYOUT } from '../renderer/layout.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { renderConversationCollapsedFragment, renderConversationEventLine } from '../renderer/conversation-surface.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import type { BlockMeta, ConversationMessageSnapshot } from './conversation';
import { parseDiffForApply } from '@pellux/goodvibes-sdk/platform/core/conversation-diff';
import { extractUserDisplayText } from '@pellux/goodvibes-sdk/platform/core/conversation-utils';

type Message = ConversationMessageSnapshot;

function summarizeCallId(callId: string, maxLength = 24): string {
  return callId.length <= maxLength ? callId : `${callId.slice(0, maxLength - 1)}…`;
}

interface ConversationRenderContext {
  readonly history: {
    addLine: (line: Line) => void;
    addLines: (lines: Line[]) => void;
    getLineCount: () => number;
  };
  readonly blockRegistry: BlockMeta[];
  readonly collapseState: Map<string, boolean>;
  readonly errorLineRegistry: number[];
  readonly configManager: ConfigManager | null;
  readonly splashOptions: SplashOptions;
}

export function renderConversationUserMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'user' }>,
  width: number,
): void {
  const displayText = extractUserDisplayText(message.content);
  if (message.cancelled) {
    context.history.addLines(UIFactory.createMessageBar(width, displayText, '#3a1a1a', '196', ' x ', true));
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
  const assistantHeaderDetails = [];
  if (message.model) {
    assistantHeaderDetails.push({ text: ` ${message.model}${message.provider ? ` (${message.provider})` : ''} `, fg: '#94a3b8', dim: true });
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    assistantHeaderDetails.push({ text: ` ${GLYPHS.status.pending} tools:${message.toolCalls.length} `, fg: '#38bdf8' });
  }
  if (message.reasoningContent || message.reasoningSummary) {
    assistantHeaderDetails.push({ text: ` ${GLYPHS.status.active} reasoning `, fg: '#a855f7', dim: true });
  }
  if (assistantHeaderDetails.length > 0) {
    context.history.addLine(renderConversationEventLine(width, {
      marker: GLYPHS.status.active,
      markerFg: '#22d3ee',
      label: 'assistant',
      labelFg: '#22d3ee',
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
    const preRendered = showAllLineNumbers
      ? renderMarkdown(message.content, width, { codeBlockLineNumbers: false })
      : null;
    const totalLines = preRendered?.length ?? 0;
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
      context.history.addLines(renderToolCallBlock(tc, 'done', undefined, width));
    }
  }
}

export function renderConversationSystemMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'system' }>,
  width: number,
): void {
  const sysStartLine = context.history.getLineCount();
  const sysLines = renderSystemMessage(message.content, width);
  context.history.addLines(sysLines);
  if (/error/i.test(message.content)) {
    context.errorLineRegistry.push(sysStartLine);
  }
}

export function renderConversationToolMessage(
  context: ConversationRenderContext,
  message: Extract<Message, { role: 'tool' }>,
  width: number,
  msgIdx: number,
): void {
  const collapseKey = `msg_${msgIdx}`;
  const blockIdx = context.blockRegistry.length;
  const startLine = context.history.getLineCount();
  const contentLines = message.content.split('\n');
  const lineCount = contentLines.length;
  const hasDiffHeader = contentLines.some((l) => l.startsWith('--- ')) && contentLines.some((l) => l.startsWith('+++ '));
  const hasHunk = contentLines.some((l) => l.startsWith('@@ '));
  const isDiff = hasDiffHeader && hasHunk;
  const blockType: 'diff' | 'tool' = isDiff ? 'diff' : 'tool';

  const isShort = message.content.length <= 200;
  const isCollapsed = isShort
    ? false
    : context.collapseState.has(collapseKey)
      ? context.collapseState.get(collapseKey)!
      : true;

  if (!context.collapseState.has(collapseKey)) {
    context.collapseState.set(collapseKey, isShort ? false : true);
  }

  context.history.addLine(renderConversationEventLine(width, {
    marker: blockType === 'diff' ? GLYPHS.status.dualPane : GLYPHS.status.active,
    markerFg: blockType === 'diff' ? '#f59e0b' : '#38bdf8',
    label: blockType === 'diff' ? 'diff' : 'tool result',
    labelFg: blockType === 'diff' ? '#f59e0b' : '#38bdf8',
    detailFg: '244',
  }, [
    ...(message.toolName
      ? [{ text: ` ${message.toolName} `, fg: '#e2e8f0' as const }]
      : [{ text: ` ${summarizeCallId(message.callId || 'standalone')} `, fg: '244' as const, dim: true }]),
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${lineCount} line${lineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
  ]));

  if (isCollapsed) {
    const collapseSuffixReserve = 30;
    const preview = contentLines[0].slice(0, width - LAYOUT.LEFT_MARGIN - LAYOUT.RIGHT_MARGIN - collapseSuffixReserve);
    const hiddenCount = lineCount - 1;
    const collapsedText = hiddenCount > 0
      ? `${preview}...  [${GLYPHS.navigation.collapsed} ${hiddenCount} hidden]`
      : preview;
    const rendered = renderConversationCollapsedFragment(collapsedText, width, {
      prefix: blockType === 'diff' ? ` ${GLYPHS.status.dualPane} ` : ` ${GLYPHS.navigation.collapsed} `,
      prefixFg: blockType === 'diff' ? '#f59e0b' : '#38bdf8',
      text: '244',
      bodyBg: '#1a1a1a',
      dim: true,
    });
    context.history.addLines(rendered);
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
    context.history.addLines(renderMarkdown(contentToRender, width));
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

  if (isDiff) {
    meta = { ...meta, ...parseDiffForApply(message.content) };
  }

  context.blockRegistry.push(meta);
}

export function appendConversationMessages(
  context: ConversationRenderContext,
  messages: Message[],
  width: number,
  messageLineRegistry: number[],
): void {
  const lineNumberMode = context.configManager?.get('display.lineNumbers') ?? 'off';
  const collapseThreshold = context.configManager?.get('display.collapseThreshold') ?? 30;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const message = messages[msgIdx];
    messageLineRegistry[msgIdx] = context.history.getLineCount();
    if (message.role === 'user') {
      renderConversationUserMessage(context, message, width);
    } else if (message.role === 'assistant') {
      renderConversationAssistantMessage(context, message, width, lineNumberMode, collapseThreshold, msgIdx);
    } else if (message.role === 'system') {
      renderConversationSystemMessage(context, message, width);
    } else if (message.role === 'tool') {
      renderConversationToolMessage(context, message, width, msgIdx);
    }
    context.history.addLine(createEmptyLine(width));
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
