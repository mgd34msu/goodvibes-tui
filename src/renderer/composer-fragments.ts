// ---------------------------------------------------------------------------
// composer-fragments.ts — composer-adjacent transcript fragments extracted from
// ui-factory.ts (file-size hygiene): the mid-turn queued-message editable list
// and the optional "used N memories" provenance chip. Pure renderers; the
// UIFactory static methods are thin wrappers over these.
// ---------------------------------------------------------------------------

import { type Line } from '../types/grid.ts';
import { renderConversationFragment } from './conversation-surface.ts';
import { activeUiTones } from './theme.ts';
import { activeTheme } from './theme.ts';

/**
 * The mid-turn message queue rendered as an EDITABLE list. Each still-undelivered
 * message shows a 1-based number so it can be named to `/queue edit <n> …` /
 * `/queue delete <n>` (the SDK editQueuedMessage / deleteQueuedMessage verbs). A
 * delivered message has already left the queue, so the list only ever shows what
 * is still editable — delivery is immutability, made visible.
 */
export function renderQueuedMessageList(width: number, items: readonly { readonly id: string; readonly text: string }[]): Line[] {
  if (items.length === 0) return [];
  const t = activeUiTones();
  const bodyBg = activeTheme().collapsedBodyBg;
  const lines: Line[] = [];
  const header = `${items.length} queued — /queue edit·delete until delivered`;
  lines.push(...renderConversationFragment(header, width, { prefix: ' ⧗ ', prefixFg: t.state.reasoning, text: t.fg.dim, bodyBg, dim: true }));
  items.forEach((item, index) => {
    lines.push(...renderConversationFragment(item.text, width, { prefix: `   ${index + 1}. `, prefixFg: t.state.reasoning, text: t.fg.dim, bodyBg, dim: true }));
  });
  return lines;
}

/**
 * The optional "used N memories" turn chip. Collapsed: one small line naming the
 * count with the drill-in hint. Expanded (Alt+M): the same line followed by one
 * line per memory id. Empty when no memories were used — the caller only renders
 * this when the memory-provenance setting is on, so an off session produces zero
 * lines and adds zero context.
 */
export function renderMemoryProvenanceChip(width: number, count: number, ids: readonly string[], expanded: boolean): Line[] {
  if (count <= 0) return [];
  const t = activeUiTones();
  const bodyBg = activeTheme().collapsedBodyBg;
  const noun = count === 1 ? 'memory' : 'memories';
  const header = expanded ? `used ${count} ${noun} — Alt+M to hide` : `used ${count} ${noun} — Alt+M to list`;
  const lines: Line[] = renderConversationFragment(header, width, { prefix: ' ◆ ', prefixFg: t.state.info, text: t.fg.dim, bodyBg, dim: true });
  if (expanded) {
    ids.forEach((id, index) => {
      lines.push(...renderConversationFragment(id, width, { prefix: `   ${index + 1}. `, prefixFg: t.state.info, text: t.fg.dim, bodyBg, dim: true }));
    });
  }
  return lines;
}
