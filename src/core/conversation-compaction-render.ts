/**
 * conversation-compaction-render.ts — folds a compaction-continuation user
 * message (the instruction block the compactor re-injects after an automatic
 * compaction) to one header + preview line.
 *
 * Extracted from conversation-rendering.ts to keep that file under the
 * architecture line-count gate; behaviour is unchanged.
 */

import { activeTheme } from '../renderer/theme.ts';
import { renderMarkdownTracked } from '../renderer/markdown.ts';
import { renderConversationCollapsedFragment, renderConversationEventLine } from '../renderer/conversation-surface.ts';
import { GLYPHS } from '../renderer/ui-primitives.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { BlockMeta } from './conversation-types.ts';

/**
 * The slice of the render context this module needs, declared structurally
 * rather than imported from conversation-rendering.ts — that import would form
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

