// ---------------------------------------------------------------------------
// composer-fragments.ts — composer-adjacent transcript fragments extracted from
// ui-factory.ts (file-size hygiene): the mid-turn queued-message editable list
// and the optional "used N memories" provenance chip. Pure renderers; the
// UIFactory static methods are thin wrappers over these.
// ---------------------------------------------------------------------------

import { type Line } from '@pellux/goodvibes-sdk/platform/types';
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
 * One drilled-in memory-provenance row. `record` is the RESOLVED record summary
 * (undefined = still resolving, null = no longer available) — the drill-in
 * shows a human summary, never a raw record id, matching the webui's detail
 * fetch (per-id, so one missing record never blanks the rest).
 */
export interface MemoryProvenanceEntry {
  readonly id: string;
  readonly record?: { readonly summary: string; readonly cls: string } | null | undefined;
}

/**
 * The optional "used N memories" turn chip. Collapsed: one small line naming the
 * count with the drill-in hint. Expanded (Alt+M): the same line followed by one
 * line per memory — its resolved SUMMARY (with the record class), a "resolving…"
 * placeholder while the fetch is in flight, or an honest "no longer available"
 * for a record that has since been forgotten. Empty when no memories were used.
 */
export function renderMemoryProvenanceChip(width: number, count: number, entries: readonly MemoryProvenanceEntry[], expanded: boolean): Line[] {
  if (count <= 0) return [];
  const t = activeUiTones();
  const bodyBg = activeTheme().collapsedBodyBg;
  const noun = count === 1 ? 'memory' : 'memories';
  const header = expanded ? `used ${count} ${noun} — Alt+M to hide` : `used ${count} ${noun} — Alt+M to list`;
  const lines: Line[] = renderConversationFragment(header, width, { prefix: ' ◆ ', prefixFg: t.state.info, text: t.fg.dim, bodyBg, dim: true });
  if (expanded) {
    entries.forEach((entry, index) => {
      const body = entry.record === undefined
        ? 'resolving…'
        : entry.record === null
          ? 'no longer available'
          : `${entry.record.summary}  ·  ${entry.record.cls}`;
      lines.push(...renderConversationFragment(body, width, { prefix: `   ${index + 1}. `, prefixFg: t.state.info, text: t.fg.dim, bodyBg, dim: true }));
    });
  }
  return lines;
}
