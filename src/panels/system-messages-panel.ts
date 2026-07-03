/**
 * SystemMessagesPanel — displays operational system messages routed away
 * from the main conversation.
 *
 * Migrated (Wave B2): extends ScrollableListPanel<SystemMessageEntry>.
 * Navigation (up/down/j/k/pageup/pagedown/g/G) is handled by the base class.
 */

import { ScrollableListPanel } from './scrollable-list-panel.ts';
import { createEmptyLine, type Line } from '../types/grid.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelListRow,
  buildPanelLine,
  buildStatusBadge,
  buildSummaryBlock,
  buildPanelWorkspace,
  resolvePrimaryScrollableSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
  type PanelWorkspaceSection,
} from './polish.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

const MAX_MESSAGES = 500;

// UI message-routing targets (ui.systemMessages / ui.operationalMessages /
// ui.wrfcMessages) all share the same enum. Cycled in-panel by s/o/w and
// persisted via ConfigManager.set (WO-137).
type RouteTarget = 'panel' | 'conversation' | 'both';
const ROUTE_CYCLE: readonly RouteTarget[] = ['panel', 'conversation', 'both'];
function nextRoute(current: string): RouteTarget {
  const idx = ROUTE_CYCLE.indexOf(current as RouteTarget);
  return ROUTE_CYCLE[(idx + 1 + ROUTE_CYCLE.length) % ROUTE_CYCLE.length]!;
}

// Domain accents only; the title band comes straight from
// DEFAULT_PANEL_PALETTE (WO-002).
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  high: '#fbbf24',
  low: '#9ca3af',
  ts: '#6b7280',
} as const);

export type SystemMessagePriority = 'high' | 'low';

export interface SystemMessageEntry {
  ts: number;
  text: string;
  priority: SystemMessagePriority;
}

// One-key priority cycle (all -> high -> low -> all), applied on top of the
// existing text filter rather than replacing it.
const PRIORITY_CYCLE: ReadonlyArray<'' | SystemMessagePriority> = ['', 'high', 'low'];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export class SystemMessagesPanel extends ScrollableListPanel<SystemMessageEntry> {
  private _messages: SystemMessageEntry[] = [];
  private readonly configManager: ConfigManager;
  /** '' = all priorities; set via the one-key priority cycle ('p'). */
  private priorityFilter: '' | SystemMessagePriority = '';
  /** c=clear backlog confirmation. */
  private confirmClear: ConfirmState<'clear'> | null = null;

  constructor(configManager: ConfigManager, componentHealthMonitor?: ComponentHealthMonitor) {
    super('system-messages', 'System Messages', '▥', 'runtime-ops', componentHealthMonitor);
    this.configManager = configManager;
    this.filterEnabled = true;
    this.filterLabel = 'Filter messages';
  }

  protected override filterMatches(entry: SystemMessageEntry, q: string): boolean {
    return entry.text.toLowerCase().includes(q) || entry.priority.toLowerCase().includes(q);
  }

  /** Text filter (base class) combined with the priority cycle filter. */
  protected override getVisibleItems(): readonly SystemMessageEntry[] {
    const base = super.getVisibleItems();
    if (!this.priorityFilter) return base;
    return base.filter((entry) => entry.priority === this.priorityFilter);
  }

  // ---------------------------------------------------------------------------
  // ScrollableListPanel contract
  // ---------------------------------------------------------------------------

  protected getItems(): readonly SystemMessageEntry[] {
    return this._messages;
  }

  protected renderItem(
    entry: SystemMessageEntry,
    index: number,
    selected: boolean,
    width: number,
  ): Line {
    const preview = entry.text.replace(/\s+/g, ' ').trim();
    return buildPanelListRow(width, [
      { text: `${fmtTime(entry.ts)}  `, fg: C.ts },
      {
        text: `${(entry.priority === 'high' ? 'HIGH' : 'LOW').padEnd(4)}  `,
        fg: entry.priority === 'high' ? C.high : C.low,
        bold: entry.priority === 'high',
      },
      { text: preview, fg: C.value },
    ], C, {
      selected,
      marker: entry.priority === 'high' ? '!' : '\u00b7',
    });
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected override getEmptyStateMessage(): string {
    return ' No system messages yet.';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  push(text: string, priority: SystemMessagePriority): void {
    // Follow-mode: only auto-jump to the new message when the selection was
    // already at the tail of what's currently visible. Otherwise the user is
    // reviewing history and a new low-priority message shouldn't yank the
    // cursor out from under them.
    const visibleBefore = this.getVisibleItems();
    const wasAtTail = visibleBefore.length === 0 || this.selectedIndex >= visibleBefore.length - 1;
    this._messages.push({ ts: Date.now(), text, priority });
    if (this._messages.length > MAX_MESSAGES) {
      this._messages.shift();
      if (this.selectedIndex > 0) this.selectedIndex--;
    }
    if (wasAtTail) {
      const visibleAfter = this.getVisibleItems();
      this.selectedIndex = Math.max(0, visibleAfter.length - 1);
    }
    this.markDirty();
  }

  get count(): number {
    return this._messages.length;
  }

  getMessages(): readonly SystemMessageEntry[] {
    return this._messages;
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  override handleInput(key: string): boolean {
    const confirmResult = handleConfirmInput(this.confirmClear, key);
    if (confirmResult === 'confirmed') {
      this.confirmClear = null;
      this._messages = [];
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirmClear = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    if (!this.filterActive && key === 'p') {
      const idx = PRIORITY_CYCLE.indexOf(this.priorityFilter);
      this.priorityFilter = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length]!;
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 's') {
      const ui = this.configManager.getRaw().ui;
      this.configManager.set('ui.systemMessages', nextRoute(ui.systemMessages));
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 'o') {
      const ui = this.configManager.getRaw().ui;
      this.configManager.set('ui.operationalMessages', nextRoute(ui.operationalMessages));
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 'w') {
      const ui = this.configManager.getRaw().ui;
      this.configManager.set('ui.wrfcMessages', nextRoute(ui.wrfcMessages));
      this.markDirty();
      return true;
    }
    if (!this.filterActive && key === 'c') {
      if (this._messages.length === 0) return false;
      this.confirmClear = { subject: 'clear', label: `${this._messages.length} system message(s)`, verb: 'Clear' };
      this.markDirty();
      return true;
    }

    return super.handleInput(key);
  }

  // ---------------------------------------------------------------------------
  // Render — multi-section layout (posture + list + detail)
  // ---------------------------------------------------------------------------

  // Context-aware footer: navigation keys plus filter keys that reflect the
  // current filter state (active typing / applied query / inactive).
  private footerHints(): Array<{ keys: string; label: string }> {
    const hints: Array<{ keys: string; label: string }> = [
      { keys: 'j/k', label: 'scroll' },
      { keys: 'g/G', label: 'jump' },
      { keys: 'p', label: 'priority' },
    ];
    if (this.filterActive) {
      hints.push({ keys: 'Esc', label: 'clear filter' });
    } else if (this.filterQuery) {
      hints.push({ keys: '/', label: 'edit filter' }, { keys: 'Esc', label: 'clear filter' });
    } else {
      hints.push({ keys: '/', label: 'filter' });
      if (this._messages.length > 0) hints.push({ keys: 'c', label: 'clear' });
    }
    return hints;
  }

  override render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
      if (this.confirmClear) {
        this.needsRender = false;
        const lines = buildPanelWorkspace(width, height, {
          title: 'System Messages',
          sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirmClear) }],
          palette: C,
        });
        while (lines.length < height) lines.push(createEmptyLine(width));
        return lines.slice(0, height);
      }

      const intro = 'Operational system traffic routed out of the main conversation to reduce noise and keep runtime status reviewable.';

      if (this._messages.length === 0) {
        this.needsRender = false;
        const lines = buildPanelWorkspace(width, height, {
          title: 'System Messages',
          intro,
          sections: [{
            lines: buildEmptyState(
              width,
              this.getEmptyStateMessage(),
              'Model switches, scan notices, provider/system state, and other operational updates will appear here once the runtime starts emitting them.',
              [
                { command: '/help', summary: 'review command and workflow surfaces' },
                { command: '/cockpit', summary: 'open the unified runtime control room' },
              ],
              C,
            ),
          }],
          footerLines: [
            buildPanelLine(width, [['  Low-priority system traffic lands here by default. Routing is configurable via /settings.', C.dim]]),
          ],
          palette: C,
        });
        return lines;
      }

      const highCount = this._messages.filter((entry) => entry.priority === 'high').length;
      const lowCount = this._messages.length - highCount;
      this.selectedIndex = Math.min(this.selectedIndex, this._messages.length - 1);
      const ui = this.configManager.getRaw().ui;
      const latest = this._messages[this._messages.length - 1];
      const postureLines = [
        // Severity + recency first: high-priority count leads, newest message age follows.
        buildPanelLine(width, [
          ['  ', C.label],
          ...buildStatusBadge(highCount > 0 ? 'failed' : 'completed', 'high', { count: highCount }),
          ['    ', C.dim],
          ...buildStatusBadge('review', 'low', { count: lowCount }),
          ...(latest ? ([['    newest ', C.label], [`${fmtTime(latest.ts)}`, C.value]] as Array<[string, string]>) : []),
        ]),
        buildKeyValueLine(width, [
          { label: 'system route (s)', value: ui.systemMessages, valueColor: C.info },
          { label: 'ops route (o)', value: ui.operationalMessages, valueColor: C.info },
          { label: 'wrfc route (w)', value: ui.wrfcMessages, valueColor: C.info },
        ], C),
        buildGuidanceLine(width, '/settings', 'review the full settings surface (routing is also toggleable in-panel with s/o/w)', C),
      ];

      const visible = this.getVisibleItems();
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, visible.length - 1));
      const selected = this.getSelectedItem();
      const noMatchReason = this.filterQuery.trim()
        ? `"${this.filterQuery.trim()}"${this.priorityFilter ? ` + priority:${this.priorityFilter}` : ''}`
        : `priority:${this.priorityFilter}`;
      const messageRows: Line[] = visible.length > 0
        ? visible.map((entry, index) => this.renderItem(entry, index, index === this.selectedIndex, width))
        : [buildPanelLine(width, [[`  No messages match ${noMatchReason}  (Esc to clear filter, p to reset priority)`, C.dim]])];

      const filterSection: PanelWorkspaceSection = { lines: [this.buildFilterLine(width)] };
      const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'System posture', postureLines, C) };
      const detailSection: PanelWorkspaceSection = selected
        ? {
            title: 'Selected Message',
            lines: [
              buildPanelLine(width, [
                [' Time ', C.label],
                [fmtTime(selected.ts), C.value],
                ['   Priority ', C.label],
                [selected.priority, selected.priority === 'high' ? C.high : C.low],
              ]),
              ...buildBodyText(width, selected.text, C, C.value),
            ],
          }
        : { title: 'Selected Message', lines: [] };
      const messagesSection = resolvePrimaryScrollableSection(width, height, {
        intro,
        palette: C,
        beforeSections: [filterSection, postureSection],
        section: {
          title: 'Timeline',
          scrollableLines: messageRows,
          selectedIndex: this.selectedIndex,
          scrollOffset: this.scrollStart,
          minRows: 4,
          appendWindowSummary: { dimColor: C.ts },
        },
        afterSections: [detailSection],
      });
      this.scrollStart = messagesSection.scrollOffset;
      const sections: PanelWorkspaceSection[] = [
        filterSection,
        postureSection,
        messagesSection.section,
        detailSection,
      ];
      this.needsRender = false;
      const lines = buildPanelWorkspace(width, height, {
        title: 'System Messages',
        intro,
        sections,
        footerLines: [buildKeyboardHints(width, this.footerHints(), C)],
        palette: C,
      });
      return lines;
    });
  }
}
