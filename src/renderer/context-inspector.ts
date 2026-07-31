import { type Line } from '@pellux/goodvibes-sdk/platform/types';
import { ModalFactory } from './modal-factory.ts';
import type { ConversationManager } from '../core/conversation';
import { getOverlayContentBudget, getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';
import { estimateTokens } from '@pellux/goodvibes-sdk/platform/core';
import { UI_TONES } from './ui-primitives.ts';

// ─── ContextInspectorModal ────────────────────────────────────────────────────

/**
 * ContextInspectorModal — state for the context inspector overlay.
 */
export class ContextInspectorModal {
  public active = false;

  open(): void {
    this.active = true;
  }

  close(): void {
    this.active = false;
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

/**
 * Render the context inspector as Line[] for overlay in the viewport.
 *
 * Lists each message with role, estimated token count, and percentage of total
 * context. Highlights large consumers (>10%). Shows total vs context window
 * capacity and suggests compaction targets.
 *
 * @param conversation  The conversation manager to inspect.
 * @param width         Terminal width.
 * @param _height       Terminal height (reserved for future scrolling).
 * @param contextWindow Optional context window size for capacity display.
 */
export function renderContextInspector(
  conversation: ConversationManager,
  width: number,
  viewportHeight = 24,
  contextWindow = 0,
): Line[] {
  const messages = conversation.getMessagesForLLM();
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    margin: 1,
    maxWidth: 78,
    chromeRows: 7,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const targetContentRows = getStableOverlayContentRows(metrics.contentRows, 8);

  if (messages.length === 0) {
    return ModalFactory.createModal({
      title: 'Context Inspector',
      width: metrics.boxWidth,
      margin: metrics.margin,
      targetContentRows,
      sections: [
        { type: 'text', content: 'No messages in conversation yet.' },
      ],
      hints: ['[Esc] Close'],
    }, width);
  }

  // ── Token accounting ──────────────────────────────────────────────────────

  type MsgEntry = {
    role: string;
    tokens: number;
    label: string;
  };

  const entries: MsgEntry[] = [];
  let totalTokens = 0;

  for (const msg of messages) {
    const role = msg.role;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      // ContentPart[]
      text = (msg.content as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    }
    // Include tool call text for assistant messages
    if (role === 'assistant' && (msg as { toolCalls?: Array<{ name: string; arguments: unknown }> }).toolCalls) {
      const tcs = (msg as { toolCalls?: Array<{ name: string; arguments: unknown }> }).toolCalls!;
      for (const tc of tcs) {
        text += tc.name + JSON.stringify(tc.arguments);
      }
    }
    const tokens = estimateTokens(text);
    totalTokens += tokens;

    let label: string;
    if (role === 'user') {
      label = `user: ${text.slice(0, 40).replace(/\n/g, ' ')}${text.length > 40 ? '...' : ''}`;
    } else if (role === 'assistant') {
      label = `assistant: ${text.slice(0, 36).replace(/\n/g, ' ')}${text.length > 36 ? '...' : ''}`;
    } else if (role === 'tool') {
      const toolMsg = msg as { callId?: string };
      label = `tool-result (${(toolMsg.callId ?? '').slice(0, 12)})`;
    } else {
      label = role;
    }

    entries.push({ role, tokens, label });
  }

  // ── Identify large consumers (>10%) ───────────────────────────────────────

  const largeThreshold = totalTokens * 0.10;

  // ── Build sections ────────────────────────────────────────────────────────

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  // Summary header
  const capacityStr = contextWindow > 0
    ? `  |  Capacity: ${fmtN(totalTokens)} / ${fmtN(contextWindow)} (${fmtPct(totalTokens / contextWindow)})`
    : '';
  sections.push({
    type: 'text',
    content: `Total: ~${fmtN(totalTokens)} tokens (${messages.length} messages)${capacityStr}`,
    style: { bold: true },
  });

  if (contextWindow > 0 && totalTokens / contextWindow >= 0.80) {
    sections.push({
      type: 'text',
      content: 'WARNING: context is 80%+ full. Run /compact to free space.',
      style: { fg: UI_TONES.state.warn, bold: true },
    });
  }

  sections.push({ type: 'separator' });

  // Per-message list (up to 20 rows to keep modal manageable)
  const maxVisibleRows = getOverlayContentBudget(viewportHeight, {
    chromeRows: 7,
    minContentRows: 6,
    maxContentRows: 10,
  });
  const display = entries.slice(-maxVisibleRows);
  const startOffset = entries.length - display.length;
  if (startOffset > 0) {
    sections.push({
      type: 'text',
      content: `(${startOffset} older messages not shown)`,
      style: { dim: true },
    });
  }

  for (let i = 0; i < display.length; i++) {
    const e = display[i];
    const pct = totalTokens > 0 ? e.tokens / totalTokens : 0;
    const pctStr = fmtPct(pct).padStart(6);
    const tokStr = `~${fmtN(e.tokens)}`.padStart(8);
    const isLarge = e.tokens > largeThreshold;
    const marker = isLarge ? '* ' : '  ';
    const line = `${marker}${pctStr}  ${tokStr}  ${e.label}`;
    sections.push({
      type: 'text',
      content: line,
      style: isLarge ? { fg: UI_TONES.state.warn, bold: true } : {},
    });
  }

  // Compaction suggestions
  const largeMsgs = entries.filter((e) => e.tokens > largeThreshold);
  if (largeMsgs.length > 0) {
    sections.push({ type: 'separator' });
    const largePct = fmtPct(
      largeMsgs.reduce((s, e) => s + e.tokens, 0) / totalTokens,
    );
    sections.push({
      type: 'text',
      content: `Compaction hint: ${largeMsgs.length} message${largeMsgs.length > 1 ? 's' : ''} use ${largePct} of context.`,
      style: { fg: '#00ffcc' },
    });
    sections.push({
      type: 'text',
      content: 'Run /compact to summarise and reduce context size.',
      style: { dim: true },
    });
  }

  return ModalFactory.createModal({
    title: 'Context Inspector',
    width: metrics.boxWidth,
    margin: metrics.margin,
    targetContentRows,
    sections,
    hints: ['[*] >10% of context', '[Esc] Close'],
  }, width);
}
