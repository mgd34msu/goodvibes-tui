// ---------------------------------------------------------------------------
// SessionBrowserPanel — browse, search, and resume old sessions.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { createStyledCell, createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { getSessionManager } from '../sessions/manager.ts';
import type { SessionInfo } from '../sessions/manager.ts';
import { logger } from '../utils/logger.ts';

const C = {
  headerBg:   '#1a1a2e',
  headerFg:   '#ffffff',
  statusBar:  '#222233',
  statusFg:   '#aaaaaa',
  selected:   '#00ffff',
  selectedBg: '#1a2a3a',
  normal:     '#ccccdd',
  dim:        '#555566',
  label:      '#8888bb',
  value:      '#ccccdd',
  dateFg:     '#6699aa',
  modelFg:    '#99aacc',
  countFg:    '#88bbcc',
  warnFg:     '#ffcc44',
  errorFg:    '#ff6666',
  separator:  '#333355',
} as const;

function renderText(
  width: number,
  text: string,
  fg: string,
  bg: string,
  bold = false,
  dim = false,
): Line {
  const cells: Line = [];
  const truncated = text.length > width ? text.slice(0, width) : text;
  for (const ch of truncated) {
    cells.push(createStyledCell(ch, { fg, bg, bold, dim }));
  }
  while (cells.length < width) {
    cells.push(createStyledCell(' ', { fg: '', bg }));
  }
  return cells.slice(0, width);
}

function shortDate(ts: number): string {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

// ---------------------------------------------------------------------------
// Confirmation state for deletion
// ---------------------------------------------------------------------------
type ConfirmState = { sessionName: string } | null;

export class SessionBrowserPanel extends BasePanel {
  private sessions: SessionInfo[] = [];
  private filtered: SessionInfo[] = [];
  private searchQuery = '';
  private searching = false; // true when user is actively typing a search
  private cursorIndex = 0;
  private scrollOffset = 0;
  private confirm: ConfirmState = null;
  private deleteError = '';
  private loadError = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private resumeSession?: (sessionId: string) => void) {
    super('sessions', 'Sessions', 'H', 'session');
  }

  override onActivate(): void {
    super.onActivate();
    this._load();
    this.refreshTimer = setInterval(() => { this._load(); }, 5000);
  }

  override onDeactivate(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    this.searching = false;
    this.confirm = null;
    super.onDeactivate();
  }

  handleInput(key: string): boolean {
    // Confirmation dialog
    if (this.confirm) {
      if (key === 'y') {
        this._deleteConfirmed();
        return true;
      } else if (key === 'n' || key === 'escape') {
        this.confirm = null;
        this.markDirty();
        return true;
      }
      return true;
    }

    // Search mode
    if (this.searching) {
      if (key === 'escape' || key === 'return') {
        this.searching = false;
        this.markDirty();
        return true;
      }
      if (key === 'backspace') {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this._filter();
        return true;
      }
      if (key.length === 1) {
        this.searchQuery += key;
        this._filter();
        return true;
      }
      return false;
    }

    switch (key) {
      case 'up':       this._move(-1);      return true;
      case 'down':     this._move(1);       return true;
      case 'pageup':   this._move(-10);     return true;
      case 'pagedown': this._move(10);      return true;
      case '/':        this._startSearch(); return true;
      case 'return':   this._resume();      return true;
      case 'd':        this._promptDelete(); return true;
      case 'r':        this._load();        return true;
      default:         return false;
    }
  }

  render(width: number, height: number): Line[] {
    const lines: Line[] = [];
    if (height <= 0 || width <= 0) return lines;

    // Header
    const count = this.filtered.length;
    const total = this.sessions.length;
    const title = ` Sessions [${count}/${total}]`;
    lines.push(renderText(width, title, C.headerFg, C.headerBg, true));
    if (height <= 1) return lines.slice(0, height);

    // Search bar
    const searchLine = this.searching
      ? ` Search: ${this.searchQuery}▊`
      : this.loadError
      ? ` Error: ${this.loadError}`
      : this.deleteError
      ? ` Error: ${this.deleteError}`
      : this.searchQuery
      ? ` Filter: ${this.searchQuery}  (/ to edit)`
      : ` / to search  Enter: resume  d: delete  r: refresh`;
    const statusFg = this.loadError || this.deleteError ? C.errorFg : C.statusFg;
    lines.push(renderText(width, searchLine, this.searching ? C.selected : statusFg, C.statusBar));
    if (height <= 2) return lines.slice(0, height);

    // Confirmation overlay
    if (this.confirm) {
      const msg = ` Delete "${this.confirm.sessionName}"? (y/n)`;
      lines.push(renderText(width, msg, C.warnFg, C.headerBg, true));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Session list
    const listHeight = height - 2;
    if (this.filtered.length === 0) {
      const msg = this.searchQuery
        ? ` No sessions match "${this.searchQuery}"`
        : ` No sessions found. Conversations are saved automatically.`;
      lines.push(renderText(width, msg, C.dim, '', false, true));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    // Clamp cursor
    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, this.filtered.length - 1));
    // Scroll to keep cursor visible
    if (this.cursorIndex < this.scrollOffset) this.scrollOffset = this.cursorIndex;
    if (this.cursorIndex >= this.scrollOffset + listHeight) this.scrollOffset = this.cursorIndex - listHeight + 1;

    const visible = this.filtered.slice(this.scrollOffset, this.scrollOffset + listHeight);
    for (let i = 0; i < visible.length; i++) {
      const sess = visible[i]!;
      const absIdx = this.scrollOffset + i;
      const isCursor = absIdx === this.cursorIndex;
      lines.push(this._renderSession(width, sess, isCursor));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }

  private _renderSession(width: number, sess: SessionInfo, isCursor: boolean): Line {
    const bg = isCursor ? C.selectedBg : '';
    const cells: Line = [];

    // Cursor indicator
    cells.push(createStyledCell(isCursor ? '>' : ' ', { fg: C.selected, bg, bold: isCursor }));

    // Date (16 chars)
    const date = shortDate(sess.timestamp);
    for (const ch of date) {
      cells.push(createStyledCell(ch, { fg: C.dateFg, bg }));
    }
    cells.push(createStyledCell(' ', { fg: '', bg }));

    // Message count (5 chars)
    const cnt = String(sess.messageCount).padStart(3) + 'm ';
    for (const ch of cnt) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: C.countFg, bg }));
    }

    // Model (truncated to 20 chars)
    const model = (sess.model || 'unknown').slice(0, 18).padEnd(18) + ' ';
    for (const ch of model) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: C.modelFg, bg }));
    }

    // Title / name (rest of width)
    const used = cells.length;
    const remaining = Math.max(0, width - used);
    const title = (sess.title || sess.name || '(untitled)').slice(0, remaining);
    for (const ch of title) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, { fg: isCursor ? C.selected : C.normal, bg, bold: isCursor }));
    }

    while (cells.length < width) {
      cells.push(createStyledCell(' ', { fg: '', bg }));
    }
    return cells.slice(0, width);
  }

  private _load(): void {
    try {
      const sm = getSessionManager();
      this.sessions = sm.list();
      this._filter();
      this.loadError = '';
      this.markDirty();
    } catch (e) {
      logger.debug('SessionBrowserPanel._load failed', { error: String(e) });
      this.loadError = 'Failed to load sessions';
      this.markDirty();
    }
  }

  private _filter(): void {
    if (!this.searchQuery.trim()) {
      this.filtered = [...this.sessions];
    } else {
      const q = this.searchQuery.toLowerCase();
      try {
        const sm = getSessionManager();
        const results = sm.search(q);
        const names = new Set(results.map(r => r.session.name));
        this.filtered = this.sessions.filter(s => names.has(s.name));
      } catch (e) {
        logger.debug('SessionBrowserPanel._filter search failed, falling back', { error: String(e) });
        this.filtered = this.sessions.filter(s =>
          (s.title || '').toLowerCase().includes(q) ||
          (s.model || '').toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q)
        );
      }
    }
    this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.filtered.length - 1));
    this.markDirty();
  }

  private _startSearch(): void {
    this.searching = true;
    this.markDirty();
  }

  private _move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.filtered.length - 1, this.cursorIndex + delta));
    this.markDirty();
  }

  private _resume(): void {
    const sess = this.filtered[this.cursorIndex];
    if (!sess) return;
    this.resumeSession?.(sess.name);
  }

  private _promptDelete(): void {
    const sess = this.filtered[this.cursorIndex];
    if (!sess) return;
    this.confirm = { sessionName: sess.name };
    this.markDirty();
  }

  private _deleteConfirmed(): void {
    if (!this.confirm) return;
    const name = this.confirm.sessionName;
    this.confirm = null;
    try {
      const sm = getSessionManager();
      sm.delete(name);
      this.deleteError = '';
      this._load();
    } catch (e) {
      logger.debug('SessionBrowserPanel._deleteConfirmed failed', { error: String(e) });
      this.deleteError = `Delete failed: ${name}`;
    }
    this.markDirty();
  }
}
