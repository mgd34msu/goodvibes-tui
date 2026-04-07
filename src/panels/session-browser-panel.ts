// ---------------------------------------------------------------------------
// SessionBrowserPanel — browse, search, and resume old sessions.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { getSessionManager } from '../sessions/manager.ts';
import type { SessionInfo } from '../sessions/manager.ts';
import { logger } from '../utils/logger.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildSearchInputLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';

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
      const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursorIndex, itemCount: this.filtered.length });
      if (transition === 'focus-list') {
        this.searching = false;
        this.cursorIndex = 0;
        this.markDirty();
        return true;
      }
      if (isPanelSearchCancel(key) || isPanelSearchCommit(key)) {
        this.searching = false;
        this.markDirty();
        return true;
      }
      if (isPanelSearchBackspace(key)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this._filter();
        return true;
      }
      if (isPanelSearchPrintable(key)) {
        this.searchQuery += key;
        this._filter();
        return true;
      }
      return false;
    }

    const transition = getPanelSearchFocusTransition(key, { selectedIndex: this.cursorIndex, itemCount: this.filtered.length });
    if (transition === 'focus-search') {
      this._startSearch();
      return true;
    }

    switch (key) {
      case 'up':       this._move(-1);      return true;
      case 'down':     this._move(1);       return true;
      case 'pageup':   this._move(-10);     return true;
      case 'pagedown': this._move(10);      return true;
      case 'return':   this._resume();      return true;
      case 'd':        this._promptDelete(); return true;
      case 'r':        this._load();        return true;
      default:         return false;
    }
  }

  render(width: number, height: number): Line[] {
    if (height <= 0 || width <= 0) return [];

    const count = this.filtered.length;
    const total = this.sessions.length;
    const searchLine = this.searching
      ? ` Search: ${this.searchQuery}_`
      : this.loadError
      ? ` Error: ${this.loadError}`
      : this.deleteError
      ? ` Error: ${this.deleteError}`
      : this.searchQuery
      ? ` Filter: ${this.searchQuery}  (/ or up at top to edit)`
      : ` / or up at top to search  Enter: resume  d: delete  r: refresh`;
    const statusFg = this.loadError || this.deleteError ? DEFAULT_PANEL_PALETTE.bad : this.searching ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim;
    const footerLines = [
      buildSearchInputLine(width, '', searchLine.trimStart(), DEFAULT_PANEL_PALETTE, { active: this.searching, valueColor: statusFg }),
    ];

    if (this.confirm) {
      return buildPanelWorkspace(width, height, {
        title: ` Sessions [${count}/${total}]`,
        intro: 'Browse, search, resume, and prune saved conversations.',
        sections: [
          {
            title: 'Confirmation',
            lines: [
              buildPanelLine(width, [[` Delete "${this.confirm.sessionName}"?`, DEFAULT_PANEL_PALETTE.warn]]),
              buildPanelLine(width, [[' y', DEFAULT_PANEL_PALETTE.info], ['  confirm delete', DEFAULT_PANEL_PALETTE.dim], ['   n / Esc', DEFAULT_PANEL_PALETTE.info], ['  cancel', DEFAULT_PANEL_PALETTE.dim]]),
            ],
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    if (this.filtered.length === 0) {
      const emptyTitle = this.searchQuery ? ` No sessions match "${this.searchQuery}"` : ' No sessions found';
      const emptyBody = this.searchQuery
        ? 'Clear or change the current filter to surface saved conversations again.'
        : 'Conversations are saved automatically. Once you have saved sessions, they appear here for review and resume.';
      return buildPanelWorkspace(width, height, {
        title: ` Sessions [${count}/${total}]`,
        intro: 'Browse, search, resume, and prune saved conversations.',
        sections: [
          {
            lines: buildEmptyState(width, emptyTitle, emptyBody, [], DEFAULT_PANEL_PALETTE),
          },
        ],
        footerLines,
        palette: DEFAULT_PANEL_PALETTE,
      });
    }

    this.cursorIndex = Math.max(0, Math.min(this.cursorIndex, this.filtered.length - 1));
    const summary: PanelWorkspaceSection = {
      title: 'Summary',
      lines: [
        buildPanelLine(width, [
          [' Sessions ', DEFAULT_PANEL_PALETTE.label],
          [String(total), DEFAULT_PANEL_PALETTE.value],
          ['   Visible ', DEFAULT_PANEL_PALETTE.label],
          [String(count), DEFAULT_PANEL_PALETTE.info],
          ['   Search ', DEFAULT_PANEL_PALETTE.label],
          [this.searchQuery || 'none', this.searchQuery ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
        ]),
      ],
    };

    const window = getTrackedVisibleWindow(this.filtered.length, this.cursorIndex, Math.max(6, height - 8), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const sessionRows = this.filtered.slice(window.start, window.end).map((sess, index) =>
      this._renderSession(width, sess, window.start + index === this.cursorIndex),
    );

    const selected = this.filtered[this.cursorIndex];
    const selectedSection: PanelWorkspaceSection = selected
      ? {
          title: 'Selected',
          lines: [
            buildPanelLine(width, [[' Title ', DEFAULT_PANEL_PALETTE.label], [selected.title || selected.name || '(untitled)', DEFAULT_PANEL_PALETTE.value]]),
            buildPanelLine(width, [[' Model ', DEFAULT_PANEL_PALETTE.label], [selected.model || 'unknown', DEFAULT_PANEL_PALETTE.info]]),
            buildPanelLine(width, [[' Date ', DEFAULT_PANEL_PALETTE.label], [shortDate(selected.timestamp), DEFAULT_PANEL_PALETTE.value], ['   Messages ', DEFAULT_PANEL_PALETTE.label], [String(selected.messageCount), DEFAULT_PANEL_PALETTE.value]]),
          ],
        }
      : { title: 'Selected', lines: [] };

    return buildPanelWorkspace(width, height, {
      title: ` Sessions [${count}/${total}]`,
      intro: 'Browse, search, resume, and prune saved conversations.',
      sections: [
        summary,
        { title: 'Sessions', lines: sessionRows },
        selectedSection,
      ],
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
    });
  }

  private _renderSession(width: number, sess: SessionInfo, isCursor: boolean): Line {
    const bg = isCursor ? C.selectedBg : '';
    const date = shortDate(sess.timestamp);
    const cnt = String(sess.messageCount).padStart(3) + 'm ';
    const model = (sess.model || 'unknown').slice(0, 18).padEnd(18) + ' ';
    const prefixLength = 1 + 16 + 1 + 4 + 19;
    const title = truncateDisplay(sess.title || sess.name || '(untitled)', Math.max(0, width - prefixLength));
    return buildStyledPanelLine(width, [
      { text: isCursor ? '>' : ' ', fg: C.selected, bg, bold: isCursor },
      { text: date, fg: C.dateFg, bg },
      { text: ' ', fg: C.normal, bg },
      { text: cnt, fg: C.countFg, bg },
      { text: model, fg: C.modelFg, bg },
      { text: title, fg: isCursor ? C.selected : C.normal, bg, bold: isCursor },
    ]);
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
