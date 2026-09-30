/**
 * agents-modal-text.ts, the plain-text pieces the Agents modal shows: the
 * hosted session's header facts and rows, and a compact live tail of an
 * agent's conversation for the side column.
 *
 * Every hosted fact is a field of the daemon's own record; nothing is derived
 * here. The tail shows what an agent said and did most recently: its words,
 * the tools it called (→) and the first line of each result (←).
 */

import type { ConversationMessageSnapshot } from '@pellux/goodvibes-sdk/platform/core';
import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import type { HostedSessionFeedState, HostedSessionRow } from '../views/hosted-session-feed.ts';
import type { AgentsText } from '../renderer/agents-modal.ts';
import { activeTokens } from '../renderer/theme.ts';
import { wrapText, getDisplayWidth } from '../utils/terminal-width.ts';

/** What the hosted session is, what it is doing, and what leaving it would do. */
export function hostedHeaderTexts(state: HostedSessionFeedState): AgentsText[] {
  const record = state.record;
  if (!record) return [];
  const lines: AgentsText[] = [
    { text: `${record.status} · ${record.turnCount} turn${record.turnCount === 1 ? '' : 's'} · ${record.messageCount} message${record.messageCount === 1 ? '' : 's'}`, tone: 'text' },
    { text: `workspace ${record.workspaceRoot}`, tone: 'faint' },
    {
      text: `${record.effectiveDetachPolicy === 'survive' ? 'leaving keeps it running (survive)' : 'leaving ends it (kill)'}, ${record.detachPolicy === null ? 'from the setting' : 'set for this session'}`,
      tone: record.effectiveDetachPolicy === 'survive' ? 'success' : 'warning',
    },
    { text: `attached: ${record.attachedClients.length > 0 ? record.attachedClients.join(', ') : 'nobody'}`, tone: 'muted' },
  ];
  if (record.status === 'terminated') lines.push({ text: `ended: ${record.terminatedReason ?? 'no reason recorded'}`, tone: 'error' });
  if (record.restoredFromDisk) lines.push({ text: 'restored from disk after a daemon restart', tone: 'warning' });
  lines.push(state.streaming
    ? { text: 'live event stream open', tone: 'success' }
    : { text: `no live stream: ${state.streamNote ?? 'not subscribed'}`, tone: 'warning' });
  if (state.runningToolCalls.length > 0) {
    lines.push({ text: `running: ${state.runningToolCalls.map((call) => call.tool).join(', ')}`, tone: 'brand' });
  }
  if (state.droppedRows > 0) lines.push({ text: `${state.droppedRows} earlier row(s) dropped; reattach to backfill`, tone: 'faint' });
  return lines;
}

/** The hosted conversation's rows as text. */
export function hostedRowTexts(rows: readonly HostedSessionRow[]): AgentsText[] {
  return rows.map((row) => {
    const prefix = row.kind === 'user' ? 'you: ' : row.kind === 'tool' ? '' : row.kind === 'error' ? 'error: ' : '';
    const text = `${prefix}${row.text}${row.streaming ? ' …' : ''}`;
    if (row.kind === 'tool') return { text, tone: 'brand', glyph: '→' };
    if (row.kind === 'error') return { text, tone: 'error' };
    if (row.kind === 'user') return { text, tone: 'text', bold: true };
    if (row.kind === 'system') return { text, tone: 'faint' };
    return { text, tone: 'text' };
  });
}

/** The hosted transcript as lines at a width (text from column 5, like the transcript). */
export function hostedBody(rows: readonly HostedSessionRow[], width: number, height: number): Line[] {
  const t = activeTokens();
  const out: Line[] = [];
  const textWidth = Math.max(8, width - 9);
  for (const item of hostedRowTexts(rows)) {
    const fg = item.tone === 'error' ? t.error : item.tone === 'brand' ? t.brand : item.tone === 'faint' ? t.textFaint : t.text;
    const text = item.glyph ? `${item.glyph} ${item.text}` : item.text;
    for (const part of wrapText(text, textWidth)) {
      const line = createEmptyLine(width);
      let x = 5;
      for (const ch of part) {
        const w = getDisplayWidth(ch);
        if (w <= 0 || x + w > width - 4) break;
        line[x] = { ...line[x]!, char: ch, fg, bold: item.bold === true };
        if (w === 2) line[x + 1] = { ...line[x]!, char: '' };
        x += w;
      }
      out.push(line);
    }
  }
  return out.slice(-Math.max(1, height));
}

function contentText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text ?? '' : `[${part.type}]`)).join(' ');
}

/** The one argument that says what a tool call is about (a path, a command, a query). */
function callSubject(args: Record<string, unknown>): string {
  for (const key of ['path', 'file_path', 'filePath', 'command', 'cmd', 'pattern', 'query', 'url', 'name']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
}

/** The most recent `limit` entries of an agent's conversation, as tail lines. */
export function transcriptTail(snapshot: readonly ConversationMessageSnapshot[], limit: number): AgentsText[] {
  const out: AgentsText[] = [];
  for (const message of snapshot) {
    if (message.role === 'user') {
      const text = firstLine(contentText(message.content as string));
      if (text) out.push({ text: `you: ${text}`, tone: 'text', bold: true });
    } else if (message.role === 'assistant') {
      const text = message.content.trim();
      if (text) for (const paragraph of text.split(/\n\s*\n/).slice(-2)) out.push({ text: paragraph.replace(/\s+/g, ' ').trim(), tone: 'text' });
      for (const call of message.toolCalls ?? []) {
        const subject = callSubject(call.arguments);
        out.push({ text: subject ? `${call.name} ${subject}` : call.name, tone: 'muted', glyph: '→' });
      }
    } else if (message.role === 'tool') {
      const text = firstLine(message.content);
      out.push({ text: `${message.toolName ?? 'result'}${text ? `: ${text}` : ''}`, tone: 'faint', glyph: '←' });
    }
  }
  if (out.length === 0) out.push({ text: 'No messages yet.', tone: 'faint' });
  return out.slice(-limit);
}
