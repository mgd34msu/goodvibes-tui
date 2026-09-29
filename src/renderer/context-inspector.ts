import type { ConversationManager } from '../core/conversation';
import { estimateTokens } from '@pellux/goodvibes-sdk/platform/core';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  scrollCountText,
  type KitHint,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, measureRow, type KitRow } from './surface-kit-list.ts';
import { drawTextBlock, modalHeightFor, modalTextWidth, textBlockHeight, type TextLine } from './surface-kit-extra.ts';

// ─── ContextInspectorModal ────────────────────────────────────────────────────

/**
 * ContextInspectorModal, state for the context inspector overlay. The list
 * opens on the newest messages; ↑ scrolls back toward older ones.
 */
export class ContextInspectorModal {
  public active = false;
  /** Rows scrolled back from the newest message (0 = the newest are in view). */
  public scrollBack = 0;
  /** The furthest the list can scroll back, recorded by the renderer. */
  public maxScrollBack = 0;

  open(): void {
    this.active = true;
    this.scrollBack = 0;
  }

  close(): void {
    this.active = false;
    this.scrollBack = 0;
  }

  /** Positive scrolls back toward older messages, negative toward the newest. */
  scrollBy(delta: number): void {
    this.scrollBack = Math.max(0, Math.min(this.maxScrollBack, this.scrollBack + delta));
  }
}

// ─── renderContextInspector ───────────────────────────────────────────────────

/** Format a number with thousands separators. */
function fmtN(n: number): string {
  return n.toLocaleString();
}

/** Format a percentage as XX.X%. */
function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

interface MsgEntry {
  readonly tokens: number;
  readonly label: string;
}

function messageEntries(conversation: ConversationManager): { entries: MsgEntry[]; total: number } {
  const entries: MsgEntry[] = [];
  let total = 0;
  for (const msg of conversation.getMessagesForLLM()) {
    const role = msg.role;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    }
    // Include tool call text for assistant messages
    const toolCalls = (msg as { toolCalls?: Array<{ name: string; arguments: unknown }> }).toolCalls;
    if (role === 'assistant' && toolCalls) {
      for (const tc of toolCalls) text += tc.name + JSON.stringify(tc.arguments);
    }
    const tokens = estimateTokens(text);
    total += tokens;
    // A one-line excerpt identifies the message; the inspector is about its
    // token cost, not its content.
    const excerpt = (limit: number): string => `${text.slice(0, limit).replace(/\s+/g, ' ')}${text.length > limit ? '…' : ''}`;
    let label: string;
    if (role === 'user') label = `user: ${excerpt(60)}`;
    else if (role === 'assistant') label = `assistant: ${excerpt(56)}`;
    else if (role === 'tool') label = `tool result ${((msg as { callId?: string }).callId ?? '').slice(0, 12)}`;
    else label = role;
    entries.push({ tokens, label });
  }
  return { entries, total };
}

/**
 * Render the context inspector as a SurfaceLayer in screen coordinates.
 *
 * Lists each message with its estimated token count and share of the total
 * (right-aligned), marks large consumers (>10%) with an amber ●, shows the
 * total against the context window, and suggests compaction targets.
 */
export function renderContextInspector(
  conversation: ConversationManager,
  screenWidth: number,
  screenHeight = 24,
  contextWindow = 0,
  modal?: ContextInspectorModal,
): SurfaceLayer {
  const t = activeTokens();
  const { entries, total } = messageEntries(conversation);

  if (entries.length === 0) {
    const lines: TextLine[] = [{ text: 'No messages in conversation yet.', style: { fg: t.textMuted } }];
    const width = modalTextWidth(screenWidth, screenHeight);
    const height = modalHeightFor(screenWidth, screenHeight, {}, textBlockHeight(lines, width));
    const f = beginModal(screenWidth, screenHeight, { title: 'Context inspector', height, center: true });
    drawTextBlock(f.canvas, f.l, f.top, f.r - f.l + 1, lines, f.bottom);
    return finishModal(f);
  }

  const largeThreshold = total * 0.10;
  const large = entries.filter((e) => e.tokens > largeThreshold);
  const capacity = contextWindow > 0 ? ` · ${fmtN(total)} of ${fmtN(contextWindow)} (${fmtPct(total / contextWindow)})` : '';
  const topLines: TextLine[] = [
    { text: `Total ~${fmtN(total)} tokens in ${entries.length} message${entries.length === 1 ? '' : 's'}${capacity}`, style: { fg: t.text, bold: true } },
  ];
  if (contextWindow > 0 && total / contextWindow >= 0.80) {
    topLines.push({ text: 'Context is 80% full or more. Run /compact to free space.', style: { fg: t.warning, bold: true } });
  }
  const bottomLines: TextLine[] = [];
  if (large.length > 0) {
    const share = fmtPct(large.reduce((s, e) => s + e.tokens, 0) / total);
    bottomLines.push({ text: `● ${large.length} message${large.length > 1 ? 's use' : ' uses'} ${share} of context (each over 10%).`, style: { fg: t.accent } });
    bottomLines.push({ text: 'Run /compact to summarise and reduce context size.', style: { fg: t.textFaint } });
  }

  const hints: KitHint[] = [['↑↓', 'scroll']];
  const f = beginModal(screenWidth, screenHeight, { title: 'Context inspector', hints });
  const width = f.r - f.l + 1;
  let top = drawTextBlock(f.canvas, f.l, f.top, width, topLines, f.bottom) + 1;
  const bottomRows = bottomLines.length > 0 ? textBlockHeight(bottomLines, width) + 1 : 0;
  const listBottom = f.bottom - bottomRows;
  if (bottomRows > 0) drawTextBlock(f.canvas, f.l, listBottom + 2, width, bottomLines, f.bottom);

  const rows: KitRow[] = entries.map((e) => {
    const isLarge = e.tokens > largeThreshold;
    return {
      label: e.label,
      right: `${fmtPct(total > 0 ? e.tokens / total : 0)} · ~${fmtN(e.tokens)}`,
      mark: isLarge ? '●' : undefined,
      markFg: t.warning,
      labelFg: isLarge ? t.warning : undefined,
      bold: isLarge,
    };
  });

  // Open on the newest messages: find the first row of the tail that fits,
  // then step back by the modal's scroll position.
  const listCapacity = Math.max(1, listBottom - top + 1);
  let tailStart = rows.length;
  let used = 0;
  while (tailStart > 0 && used + measureRow(rows[tailStart - 1]!, f.l, f.r) <= listCapacity) {
    tailStart--;
    used += measureRow(rows[tailStart]!, f.l, f.r);
  }
  if (modal) {
    modal.maxScrollBack = tailStart;
    modal.scrollBack = Math.min(modal.scrollBack, tailStart);
  }
  const scrollStart = Math.max(0, tailStart - (modal?.scrollBack ?? 0));
  if (top > listBottom) top = listBottom;
  const res = drawList(f.canvas, { rows, top, bottom: listBottom, x0: f.l, x1: f.r, scrollStart });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
