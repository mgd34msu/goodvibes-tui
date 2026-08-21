/**
 * conversation-compaction-render.ts, folds a compaction-continuation user
 * message (the instruction block the compactor re-injects after an automatic
 * compaction) to one header + preview line.
 *
 * Extracted from conversation-rendering.ts to keep that file under the
 * architecture line-count gate; behaviour is unchanged.
 */

import { activeTheme } from '../renderer/theme.ts';
import { renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderConversationEventLine, renderConversationFoldedRow } from '../renderer/conversation-surface.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { BlockMeta } from './conversation-types.ts';

/**
 * The slice of the render context this module needs, declared structurally
 * rather than imported from conversation-rendering.ts, that import would form
 * a 2-file cycle the architecture check rejects, and this module only ever
 * touches these three fields.
 */
export interface CompactionRenderContext {
  readonly history: {
    addLine: (line: Line) => void;
    addLines: (lines: Line[]) => void;
    getLineCount: () => number;
  };
  readonly blockRegistry: BlockMeta[];
  readonly collapseState: Map<string, boolean>;
}

/** Fold a compaction-continuation user message to one header + preview line. */
export function renderCompactionContinuationMessage(
  context: CompactionRenderContext,
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

  const tone = {
    marker: GLYPHS.status.active,
    markerFg: T.toolAccent,
    label: 'compaction handoff',
    labelFg: T.toolAccent,
    detailFg: '244',
  };
  const details = [
    { text: ` ${isCollapsed ? GLYPHS.navigation.collapsed : GLYPHS.navigation.expanded} ${lineCount} line${lineCount === 1 ? '' : 's'} `, fg: '244', dim: true },
  ];

  if (isCollapsed) {
    // One row. This used to be the header PLUS a framed fragment holding a
    // single static sentence, three rows of chrome to say what the label and
    // the badge already said. The distinguishing half of that sentence folds
    // onto the header instead.
    context.history.addLine(renderConversationFoldedRow(
      width,
      tone,
      details,
      're-injected instructions + session summary',
    ));
  } else {
    context.history.addLine(renderConversationEventLine(width, tone, details));
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

