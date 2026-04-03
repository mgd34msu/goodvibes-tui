/**
 * SystemMessagesPanel — displays operational system messages routed away
 * from the main conversation.
 *
 * Receives messages via push() from the SystemMessageRouter. High-priority
 * messages also appear in the conversation; low-priority messages appear
 * here only.
 *
 * Supports keyboard scroll (j/k, arrow keys, PgUp/PgDn, g/G).
 */

import { BasePanel } from './base-panel.ts';
import { createEmptyLine, createStyledCell, type Line } from '../types/grid.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 500;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const C = {
  title:   '#00ffff',
  high:    '#fbbf24',
  low:     '#9ca3af',
  ts:      '#6b7280',
  border:  '#374151',

  empty:   '238',
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SystemMessagePriority = 'high' | 'low';

export interface SystemMessageEntry {
  /** Unix timestamp in ms. */
  ts: number;
  /** The message text. */
  text: string;
  /** Routing priority. */
  priority: SystemMessagePriority;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// SystemMessagesPanel
// ---------------------------------------------------------------------------

/**
 * Panel that displays system/operational messages routed away from the
 * main conversation to reduce noise.
 */
export class SystemMessagesPanel extends BasePanel {
  private _messages: SystemMessageEntry[] = [];
  private _lastVisibleIdx = 0;

  constructor() {
    super('system-messages', 'System Messages', 'J', 'monitoring');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Add a message to the panel.
   *
   * @param text     - Message content.
   * @param priority - 'high' | 'low'. High messages also go to conversation.
   */
  push(text: string, priority: SystemMessagePriority): void {
    this._messages.push({ ts: Date.now(), text, priority });
    if (this._messages.length > MAX_MESSAGES) {
      this._messages.shift();
      // Adjust scroll to keep position stable
      if (this._lastVisibleIdx > 0) this._lastVisibleIdx--;
    }
    // Auto-scroll to bottom on new message
    this._lastVisibleIdx = Math.max(0, this._messages.length - 1);
    this.markDirty();
  }

  /** Return the number of stored messages. */
  get count(): number {
    return this._messages.length;
  }

  /** Return all stored messages (newest last). */
  getMessages(): readonly SystemMessageEntry[] {
    return this._messages;
  }

  // ── Input handling ────────────────────────────────────────────────────────

  handleInput(key: string): boolean {
    const prev = this._lastVisibleIdx;

    switch (key) {
      case 'j':
      case '\x1b[B': // ArrowDown
        this._lastVisibleIdx = Math.min(this._lastVisibleIdx + 1, Math.max(0, this._messages.length - 1));
        break;
      case 'k':
      case '\x1b[A': // ArrowUp
        this._lastVisibleIdx = Math.max(this._lastVisibleIdx - 1, 0);
        break;
      case '\x1b[6~': // PageDown
        this._lastVisibleIdx = Math.min(this._lastVisibleIdx + 20, Math.max(0, this._messages.length - 1));
        break;
      case '\x1b[5~': // PageUp
        this._lastVisibleIdx = Math.max(this._lastVisibleIdx - 20, 0);
        break;
      case 'g':
        this._lastVisibleIdx = 0;
        break;
      case 'G':
        this._lastVisibleIdx = Math.max(0, this._messages.length - 1);
        break;
      default:
        return false;
    }

    if (this._lastVisibleIdx !== prev) this.markDirty();
    return true;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  override render(width: number, height: number): Line[] {
    if (!this.canRenderNow()) {
      return Array.from({ length: height }, () => createEmptyLine(width));
    }

    const start = Date.now();
    const lines: Line[] = [];

    lines.push(this._titleLine(width));
    lines.push(this._hrLine(width));

    const bodyHeight = height - 2;

    if (this._messages.length === 0) {
      lines.push(this._textLine('  No system messages yet.', C.empty, width));
      while (lines.length < height) lines.push(createEmptyLine(width));
      this.reportRenderDuration(Date.now() - start);
      return lines.slice(0, height);
    }

    // Compute visible window — scrollTop is the index of the last visible msg
    const lastIdx  = Math.min(this._lastVisibleIdx, this._messages.length - 1);
    const firstIdx = Math.max(0, lastIdx - bodyHeight + 1);

    for (let i = firstIdx; i <= lastIdx; i++) {
      const entry = this._messages[i]!;
      lines.push(...this._renderEntry(entry, width));
      if (lines.length - 2 >= bodyHeight) break; // -2 for header rows
    }

    // Scroll indicator
    if (firstIdx > 0) {
      const indicator = `  ↑ ${firstIdx} earlier message${firstIdx === 1 ? '' : 's'}`;
      lines[2] = this._textLine(indicator, C.ts, width, { dim: true });
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    this.reportRenderDuration(Date.now() - start);
    return lines.slice(0, height);
  }

  // ── Section renderers ─────────────────────────────────────────────────────

  private _renderEntry(entry: SystemMessageEntry, width: number): Line[] {
    const tsStr = fmtTime(entry.ts);
    const prefix = `  ${tsStr}  `;
    const color  = entry.priority === 'high' ? C.high : C.low;
    const textWidth = width - prefix.length;

    if (textWidth <= 0) {
      return [this._textLine(entry.text.slice(0, width), color, width)];
    }

    // Word-wrap the message text
    const words = entry.text.split(' ');
    const wrappedLines: string[] = [];
    let current = '';

    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= textWidth) {
        current += ' ' + word;
      } else {
        wrappedLines.push(current);
        current = word;
      }
    }
    if (current.length > 0) wrappedLines.push(current);
    if (wrappedLines.length === 0) wrappedLines.push('');

    return wrappedLines.map((segment, idx) => {
      const line = createEmptyLine(width);
      const linePrefix = idx === 0 ? prefix : ' '.repeat(prefix.length);
      let x = 0;

      // Prefix — timestamp on first line, indent on continuation
      for (const ch of linePrefix) {
        if (x >= width) break;
        const fg = C.ts;
        line[x++] = createStyledCell(ch, { fg, dim: true });
      }

      // Text
      for (const ch of segment) {
        if (x >= width) break;
        line[x++] = createStyledCell(ch, { fg: color });
      }

      return line;
    });
  }

  // ── Line builders ─────────────────────────────────────────────────────────

  private _titleLine(width: number): Line {
    const line = createEmptyLine(width);
    const text = ' System Messages';
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg: C.title, bold: true });
    }

    // Right-aligned count
    const count = `${this._messages.length} msg${this._messages.length === 1 ? '' : 's'} `;
    let cx = width - count.length;
    for (const ch of count) {
      if (cx >= width) break;
      line[cx++] = createStyledCell(ch, { fg: C.ts, dim: true });
    }
    return line;
  }

  private _hrLine(width: number): Line {
    return Array.from({ length: width }, () =>
      createStyledCell('\u2500', { fg: C.border }),
    );
  }

  private _textLine(
    text: string,
    fg: string,
    width: number,
    opts: { dim?: boolean } = {},
  ): Line {
    const line = createEmptyLine(width);
    let x = 0;
    for (const ch of text) {
      if (x >= width) break;
      line[x++] = createStyledCell(ch, { fg, dim: opts.dim });
    }
    return line;
  }
}
