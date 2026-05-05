// ---------------------------------------------------------------------------
// SessionBrowserPanel — browse, search, and resume old sessions.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { SessionInfo } from '@pellux/goodvibes-sdk/platform/sessions';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { SessionBrowserQuery } from '../runtime/ui-service-queries.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildSearchInputLine,
  buildStyledPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  getPanelSearchFocusTransition,
  isPanelSearchBackspace,
  isPanelSearchCancel,
  isPanelSearchCommit,
  isPanelSearchPrintable,
} from './search-focus.ts';
import { type ConfirmState, handleConfirmInput } from './confirm-state.ts';

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

function formatReturnContextLines(returnContext: SessionInfo['returnContext']): string[] {
  if (!returnContext) return [];
  const lines: string[] = [];
  if (returnContext.activityLabel) lines.push(`activity: ${returnContext.activityLabel}`);
  if (returnContext.statusLabel) lines.push(`status: ${returnContext.statusLabel}`);
  if (returnContext.activeTasks || returnContext.blockedTasks || returnContext.pendingApprovals) {
    lines.push(`tasks: active=${returnContext.activeTasks ?? 0} blocked=${returnContext.blockedTasks ?? 0} approvals=${returnContext.pendingApprovals ?? 0}`);
  }
  if (returnContext.remoteRunners?.length) {
    lines.push(`remote runners: ${returnContext.remoteRunners.join(', ')}`);
  }
  if (returnContext.worktreePaths?.length) {
    lines.push(`worktrees: ${returnContext.worktreePaths.join(', ')}`);
  }
  if (returnContext.openPanels?.length) {
    lines.push(`open panels: ${returnContext.openPanels.join(', ')}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Confirmation state for deletion
// ---------------------------------------------------------------------------
// ConfirmState<string> — subject holds the session name to delete

export class SessionBrowserPanel extends BasePanel {
  private sessions: SessionInfo[] = [];
  private filtered: SessionInfo[] = [];
  private searchQuery = '';
  private searching = false; // true when user is actively typing a search
  private cursorIndex = 0;
  private scrollOffset = 0;
  private confirm: ConfirmState<string> | null = null;
  private deleteError = '';
  private loadError = '';
  private refreshTimerId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionManager: SessionBrowserQuery,
    private resumeSession?: (sessionId: string) => void,
  ) {
    super('sessions', 'Sessions', 'H', 'session');
  }

  override onActivate(): void {
    super.onActivate();
    this._load();
    this.refreshTimerId = this.registerTimer(setInterval(() => { this._load(); }, 5000));
  }

  override onDeactivate(): void {
    if (this.refreshTimerId !== null) { this.clearTimer(this.refreshTimerId); this.refreshTimerId = null; }
    this.searching = false;
    this.confirm = null;
    super.onDeactivate();
  }

  handleInput(key: string): boolean {
    // Confirmation dialog — use shared handleConfirmInput for y/n/Esc UX
    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      this._deleteConfirmed();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

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
    const intro = 'Browse, search, resume, and prune saved conversations.';

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
        intro,
        sections: [
          {
            title: 'Confirmation',
            lines: [
              buildPanelLine(width, [[` Delete "${this.confirm.subject}"?`, DEFAULT_PANEL_PALETTE.warn]]),
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
        intro,
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

    const selected = this.filtered[this.cursorIndex];
    const selectedSection: PanelWorkspaceSection = selected
      ? {
          title: 'Selected',
          lines: [
            buildPanelLine(width, [[' Title ', DEFAULT_PANEL_PALETTE.label], [selected.title || selected.name || '(untitled)', DEFAULT_PANEL_PALETTE.value]]),
            buildPanelLine(width, [[' Model ', DEFAULT_PANEL_PALETTE.label], [selected.model || 'unknown', DEFAULT_PANEL_PALETTE.info], ['   Title ', DEFAULT_PANEL_PALETTE.label], [selected.titleSource === 'user' ? 'user-set' : 'system', selected.titleSource === 'user' ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.dim]]),
            buildPanelLine(width, [[' Date ', DEFAULT_PANEL_PALETTE.label], [shortDate(selected.timestamp), DEFAULT_PANEL_PALETTE.value], ['   Messages ', DEFAULT_PANEL_PALETTE.label], [String(selected.messageCount), DEFAULT_PANEL_PALETTE.value]]),
            buildPanelLine(width, [
              [' Tasks ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.activeTasks ?? 0), (selected.returnContext?.activeTasks ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
              ['   Blocked ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.blockedTasks ?? 0), (selected.returnContext?.blockedTasks ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
              ['   Approvals ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.pendingApprovals ?? 0), (selected.returnContext?.pendingApprovals ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.warn : DEFAULT_PANEL_PALETTE.dim],
            ]),
            buildPanelLine(width, [
              [' Remote ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.remoteRunners?.length ?? 0), (selected.returnContext?.remoteRunners?.length ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
              ['   Worktrees ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.worktreePaths?.length ?? 0), (selected.returnContext?.worktreePaths?.length ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.info : DEFAULT_PANEL_PALETTE.dim],
              ['   Panels ', DEFAULT_PANEL_PALETTE.label],
              [String(selected.returnContext?.openPanels?.length ?? 0), (selected.returnContext?.openPanels?.length ?? 0) > 0 ? DEFAULT_PANEL_PALETTE.good : DEFAULT_PANEL_PALETTE.dim],
            ]),
            ...formatReturnContextLines(selected.returnContext).map((line) =>
              buildPanelLine(width, [[' ', DEFAULT_PANEL_PALETTE.dim], [truncateDisplay(line, Math.max(0, width - 2)), DEFAULT_PANEL_PALETTE.dim]])
            ),
            buildPanelLine(width, [[' Next ', DEFAULT_PANEL_PALETTE.label], [selected.returnContext?.remoteRunners?.length ? `/remote recover ${selected.returnContext.remoteRunners[0]}` : '/session resume', DEFAULT_PANEL_PALETTE.dim]]),
          ],
        }
      : { title: 'Selected', lines: [] };

    const sessionsSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: DEFAULT_PANEL_PALETTE,
      beforeSections: [summary],
      section: {
        title: 'Sessions',
        scrollableLines: this.filtered.map((sess, index) =>
          this._renderSession(width, sess, index === this.cursorIndex),
        ),
        selectedIndex: this.cursorIndex,
        scrollOffset: this.scrollOffset,
        minRows: 6,
      },
      afterSections: [selectedSection],
    });
    this.scrollOffset = sessionsSection.scrollOffset;

    return buildPanelWorkspace(width, height, {
      title: ` Sessions [${count}/${total}]`,
      intro,
      sections: [
        summary,
        sessionsSection.section,
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
      { text: isCursor ? '▸' : ' ', fg: C.selected, bg, bold: isCursor },
      { text: date, fg: C.dateFg, bg },
      { text: ' ', fg: C.normal, bg },
      { text: cnt, fg: C.countFg, bg },
      { text: model, fg: C.modelFg, bg },
      { text: title, fg: isCursor ? C.selected : C.normal, bg, bold: isCursor },
    ]);
  }

  private _load(): void {
    try {
      this.sessions = this.sessionManager.list();
      this._filter();
      this.loadError = '';
      this.markDirty();
    } catch (e) {
      logger.debug('SessionBrowserPanel._load failed', { error: summarizeError(e) });
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
        const results = this.sessionManager.search(q);
        const names = new Set(results.map(r => r.session.name));
        this.filtered = this.sessions.filter(s => names.has(s.name));
      } catch (e) {
        logger.debug('SessionBrowserPanel._filter search failed, falling back', { error: summarizeError(e) });
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
    this.confirm = { subject: sess.name, label: sess.name };
    this.markDirty();
  }

  private _deleteConfirmed(): void {
    if (!this.confirm) return;
    const name = this.confirm.subject;
    this.confirm = null;
    try {
      this.sessionManager.delete(name);
      this.deleteError = '';
      this._load();
    } catch (e) {
      logger.debug('SessionBrowserPanel._deleteConfirmed failed', { error: summarizeError(e) });
      this.deleteError = `Delete failed: ${name}`;
    }
    this.markDirty();
  }
}
