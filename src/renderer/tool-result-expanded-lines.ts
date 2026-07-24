/**
 * tool-result-expanded-lines.ts — the single source of truth for how many
 * screen lines a tool-result message's EXPANDED form actually renders to.
 *
 * Tool-result content gets pretty-printed (JSON.stringify(parsed, null, 2))
 * or diff-rendered before display, so the raw message's `content.split('\n')`
 * length is not what the user sees once expanded — a one-line JSON blob can
 * pretty-print to 50 lines. Both the per-block "N lines" badge
 * (conversation-rendering.ts) and the folded-group total (conversation-tool-
 * groups.ts) must count the SAME post-render lines, or the two disagree with
 * each other and both can disagree with what Tab actually reveals.
 */

import type { Line } from '../types/grid.ts';
import { renderMarkdownTracked } from './markdown.ts';
import { renderDiffView } from './diff-view.ts';

/** True when `content` looks like a unified diff (matches the detection used
 *  by renderConversationToolMessage to pick the diff block type). */
export function isDiffContent(content: string): boolean {
  const contentLines = content.split('\n');
  const hasDiffHeader = contentLines.some((l) => l.startsWith('--- ')) && contentLines.some((l) => l.startsWith('+++ '));
  const hasHunk = contentLines.some((l) => l.startsWith('@@ '));
  return hasDiffHeader && hasHunk;
}

/**
 * Render a tool result's content exactly as its EXPANDED form would appear in
 * the transcript (diff view for diffs; pretty-printed JSON, when parseable,
 * for everything else). The caller decides whether to actually display these
 * lines or just count them.
 */
export function renderExpandedToolResultLines(content: string, width: number): Line[] {
  if (isDiffContent(content)) {
    return renderDiffView(content, width);
  }
  let contentToRender = content;
  const trimmed = contentToRender.trimStart();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && contentToRender.length < 100_000) {
    try {
      const parsed = JSON.parse(contentToRender);
      contentToRender = `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch {
      // Leave invalid JSON as-is — falls through to the plain markdown render below.
    }
  }
  return renderMarkdownTracked(contentToRender, width).lines;
}
