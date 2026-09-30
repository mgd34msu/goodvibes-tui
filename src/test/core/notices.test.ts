/**
 * System notices are toasts plus the notification history, never transcript
 * rows (ui-live-run-5 item 9), and they keep their full text (ui-live-run-7
 * item 2: "(setFixWorkstreamRunner w" was a notice cut mid-word).
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { noticeParts, publishNotice } from '../../core/notices.ts';
import { PanelNotificationFeed } from '../../panels/notifications-feed.ts';
import { bridgeNotificationFeedToToasts, ToastCenter } from '../../renderer/toast-center.ts';
import { renderToasts } from '../../renderer/surface-kit-parts.ts';
import { renderNotificationsModal } from '../../renderer/notifications-modal.ts';
import { appendConversationMessages, type ConversationRenderContext } from '../../core/conversation-rendering.ts';
import { createEmptyLine, type Line } from '@pellux/goodvibes-sdk/platform/types';
import { frameFromLayer } from '../helpers/surface-frame.ts';

const FAILED = '[Agents] ✗ engineer b6834750: "Spawn one reviewer agent to review and verify the backoff…" — failed in 51s: planned-fix execution is not wired in this composition (setFixWorkstreamRunner was never called)';

const text = (lines: readonly Line[]): string => lines.map((line) => line.map((cell) => cell.char).join('').trimEnd()).join('\n');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

function wired() {
  const conversation = new ConversationManager(() => 100);
  const feed = new PanelNotificationFeed();
  const toasts = new ToastCenter(() => 0, () => {});
  bridgeNotificationFeedToToasts(feed, toasts);
  conversation.setNoticeSink((content, { restored }) => publishNotice(feed, content, { restored, now: () => 1_000 }));
  return { conversation, feed, toasts };
}

describe('system notices become toasts and history entries', () => {
  test('a notice added mid-turn is a toast and a history entry with its full text, and no transcript row', () => {
    const { conversation, feed, toasts } = wired();
    conversation.addUserMessage('review the retry logic');
    conversation.addAssistantMessage('Starting a reviewer.');
    conversation.addTypedSystemMessage(FAILED, 'system');
    conversation.addTypedSystemMessage('[WRFC] ✗ Chain wrfc-e9823b8 FAILED: planned-fix execution is not wired in this composition (setFixWorkstreamRunner was never called)', 'wrfc');

    const entries = feed.list();
    expect(entries).toHaveLength(2);
    expect(entries[1]!.title).toBe(FAILED);
    expect(entries[1]!.level).toBe('critical');
    expect(entries[1]!.subject).toBe('agents');
    expect(toasts.visible().map((t) => t.title)).toEqual([entries[0]!.title, FAILED]);
    expect(toasts.visible()[1]!.tone).toBe('error');

    const frame = text(conversation.getDisplayBlocks());
    expect(frame).toContain('Starting a reviewer.');
    expect(frame).not.toContain('[Agents]');
    expect(frame).not.toContain('[WRFC]');
  });

  test('a restored session puts its notices back in the history, seen and not toasted', () => {
    const { conversation, feed, toasts } = wired();
    conversation.fromJSON({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: '[Compaction] Context compacted: 40 messages summarized' }] });
    expect(feed.list().map((e) => e.title)).toEqual(['[Compaction] Context compacted: 40 messages summarized']);
    expect(feed.unreadCount()).toBe(0);
    expect(toasts.visible()).toEqual([]);
  });

  test('a multi-line notice keeps every line: the first is the title, the rest the body', () => {
    const parts = noticeParts("[Agents] Cohort 'a' complete: 1 completed, 1 failed, 0 cancelled (2 total)\n  ✓ aaaa: completed in 3s (2 tool calls)\n  ✗ bbbb: failed in 5s (1 tool calls) — boom");
    expect(parts.domain).toBe('agents');
    expect(parts.level).toBe('warning');
    expect(parts.title).toBe("[Agents] Cohort 'a' complete: 1 completed, 1 failed, 0 cancelled (2 total)");
    expect(parts.body).toBe('  ✓ aaaa: completed in 3s (2 tool calls)\n  ✗ bbbb: failed in 5s (1 tool calls) — boom');
  });
});

describe('notices show their full text, wrapped', () => {
  test('a toast wraps the whole notice at its text column', () => {
    const layer = renderToasts(120, 40, [{ title: FAILED, tone: 'error' }], { top: 1, bottom: 36 })!;
    const shown = flat(text(layer.lines).replace(/┃/g, ' '));
    expect(shown).toContain('(setFixWorkstreamRunner was never called)');
    // Text never touches the bars: two blank columns inside each ┃.
    for (const line of layer.lines) {
      const row = line.map((cell) => cell.char).join('');
      if (row.trim().length === 0) continue;
      const bar = row.indexOf('┃');
      expect(bar).toBeGreaterThan(0);
      expect(row[bar + 1]).toBe(' ');
      expect(row[bar + 2]).toBe(' ');
      expect(row[row.length - 1]).toBe('┃');
      expect(row[row.length - 2]).toBe(' ');
      expect(row[row.length - 3]).toBe(' ');
    }
  });

  test('the history modal shows the whole notice', () => {
    const feed = new PanelNotificationFeed();
    publishNotice(feed, FAILED, { now: () => Date.now() });
    const layer = renderNotificationsModal({ entries: feed.list(), selectedIndex: 0, unread: 1, isUnread: () => true, status: null, now: Date.now() }, 120, 40);
    expect(flat(text(layer.lines))).toContain('(setFixWorkstreamRunner was never called)');
  });
});

describe('toasts never cover the composer or the status line', () => {
  test('toasts stay above the footer rows', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ title: `${FAILED} #${i}`, tone: 'info' as const }));
    const layer = renderToasts(100, 20, many, { top: 1, bottom: 20 - 6 })!;
    expect(layer.y).toBe(1);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(14);
  });

  test('a toast taller than the room shows what fits and points to the history', () => {
    const tall = { title: FAILED, body: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), tone: 'warning' as const };
    const layer = renderToasts(100, 20, [tall], { top: 1, bottom: 12 })!;
    expect(layer.lines.length).toBe(11);
    expect(text(layer.lines)).toContain('full text in /notifications');
  });
});

describe('toasts keep a gap from the transcript under them', () => {
  // A transcript whose every row is a filled block with text across the full
  // fill (columns 3 to width-3), the worst case for a floating toast.
  const W = 100;
  const H = 30;
  const BLOCK_BG = '#223344';
  function transcript(): Line[] {
    return Array.from({ length: H }, () => {
      const line = createEmptyLine(W);
      for (let x = 3; x <= W - 3; x++) line[x] = { ...line[x]!, char: 'x', bg: BLOCK_BG };
      return line;
    });
  }
  const plain = (line: Line, x: number): boolean => line[x]!.char === ' ' && line[x]!.bg === '';

  test('the lowest toast has a cleared row under it and cleared columns on its left; stacked toasts a cleared row between', () => {
    const toasts = [{ title: 'First notice', tone: 'info' as const }, { title: 'Second notice', body: 'with a body', tone: 'warning' as const }];
    const layer = renderToasts(W, H, toasts, { top: 1, bottom: H - 6 })!;
    const frame = frameFromLayer(layer, W, H, transcript());
    const toastRows = frame.map((line, y) => ({ y, bars: line.map((c) => c.char).join('').split('┃').length - 1 })).filter((r) => r.bars === 2).map((r) => r.y);
    expect(toastRows.length).toBeGreaterThan(0);
    const lowest = Math.max(...toastRows);
    const left = frame[toastRows[0]!]!.findIndex((c) => c.char === '┃');
    const right = frame[toastRows[0]!]!.map((c) => c.char).lastIndexOf('┃');
    // Under the lowest toast: one full row of plain screen across its width and its left gap.
    for (let x = left - 2; x <= right; x++) expect(plain(frame[lowest + 1]!, x)).toBe(true);
    // Beside every toast row: two plain columns before the bar.
    for (const y of toastRows) {
      expect(plain(frame[y]!, left - 1)).toBe(true);
      expect(plain(frame[y]!, left - 2)).toBe(true);
    }
    // Between the two toasts: a plain row, never the block showing through.
    const gaps = [];
    for (let y = toastRows[0]!; y < lowest; y++) if (!toastRows.includes(y)) gaps.push(y);
    expect(gaps.length).toBe(1);
    for (let x = left; x <= right; x++) expect(plain(frame[gaps[0]!]!, x)).toBe(true);
    // And the gap stays inside the area, above the footer.
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H - 6);
  });
});

describe('an agent view still draws its own agent\'s system messages', () => {
  test('without systemNotices the notice is a row', () => {
    const lines: Line[] = [];
    const context: ConversationRenderContext = {
      history: { addLine: (l) => { lines.push(l); }, addLines: (ls) => { lines.push(...ls); }, getLineCount: () => lines.length },
      blockRegistry: [],
      collapseState: new Map(),
      errorLineRegistry: [],
      messageKindRegistry: new Map(),
      configManager: null,
      splashOptions: {},
    };
    appendConversationMessages(context, [{ role: 'system', content: '[Resume] prior summary' }], 80, []);
    expect(text(lines)).toContain('[Resume] prior summary');
  });
});

describe('history counts say what they count', () => {
  test('a collapsed group of mixed kinds is titled by its group, with a per-kind breakdown', () => {
    const feed = new PanelNotificationFeed();
    const decision = { target: 'panel_only' as const, reasonCode: 'batch_window_collapsed' as const, batchKey: 'agents:info' };
    const note = (title: string, i: number) => ({ id: `n${i}`, domain: 'agents', level: 'info' as const, title, timestamp: i });
    for (let i = 0; i < 5; i++) feed.record(note('Agent stream delta', i), decision);
    feed.record(note('Agent completed', 9), decision);
    const [entry] = feed.list();
    expect(entry!.collapsedCount).toBe(6);
    expect(entry!.title).toBe('Agent updates');
    expect(entry!.body).toBe('Agent stream delta ×5, Agent completed ×1');
  });

  test('a collapsed group of one kind keeps that kind as its title', () => {
    const feed = new PanelNotificationFeed();
    const decision = { target: 'panel_only' as const, reasonCode: 'burst_collapsed' as const, batchKey: 'security:warning' };
    for (let i = 0; i < 3; i++) feed.record({ id: `s${i}`, domain: 'security', level: 'warning', title: 'Permission denied', timestamp: i }, decision);
    expect(feed.list()[0]!.title).toBe('Permission denied');
    expect(feed.list()[0]!.collapsedCount).toBe(3);
  });
});

describe('toasts stay below the header rows', () => {
  test('a two-row header (session chips) pushes the toast down', () => {
    const layer = renderToasts(100, 30, [{ title: 'x', tone: 'info' }], { top: 2, bottom: 26 })!;
    expect(layer.y).toBe(2);
  });
});
