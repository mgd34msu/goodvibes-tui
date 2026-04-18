/**
 * SystemMessagesPanel — displays operational system messages routed away
 * from the main conversation.
 *
 * Migrated (Wave B2): extends ScrollableListPanel<SystemMessageEntry>.
 * Navigation (up/down/j/k/pageup/pagedown/g/G) is handled by the base class.
 */

import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { Line } from '../types/grid.ts';
import type { ComponentHealthMonitor } from '../runtime/perf/panel-health-monitor.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  resolvePrimaryScrollableSection,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  type PanelPalette,
  type PanelWorkspaceSection,
} from './polish.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

const MAX_MESSAGES = 500;

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  header: '#00ffff',
  headerBg: '#0f172a',
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

  constructor(configManager: ConfigManager, componentHealthMonitor?: ComponentHealthMonitor) {
    super('system-messages', 'System Messages', 'J', 'monitoring', componentHealthMonitor);
    this.configManager = configManager;
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
        text: `${entry.priority === 'high' ? 'HIGH' : 'LOW '.padEnd(4)}  `,
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
    this._messages.push({ ts: Date.now(), text, priority });
    if (this._messages.length > MAX_MESSAGES) {
      this._messages.shift();
      if (this.selectedIndex > 0) this.selectedIndex--;
    }
    // Auto-follow: jump to latest message
    this.selectedIndex = Math.max(0, this._messages.length - 1);
    this.markDirty();
  }

  get count(): number {
    return this._messages.length;
  }

  getMessages(): readonly SystemMessageEntry[] {
    return this._messages;
  }

  // ---------------------------------------------------------------------------
  // Input — base class handles all navigation; nothing custom here
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Render — multi-section layout (posture + list + detail)
  // ---------------------------------------------------------------------------

  override render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
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
            buildPanelLine(width, [['  j/k or Up/Down scroll  g/G jump  low-priority system traffic lands here by default', C.dim]]),
          ],
          palette: C,
        });
        return lines;
      }

      const highCount = this._messages.filter((entry) => entry.priority === 'high').length;
      const lowCount = this._messages.length - highCount;
      this.selectedIndex = Math.min(this.selectedIndex, this._messages.length - 1);
      const ui = this.configManager.getRaw().ui;
      const postureLines = [
        buildKeyValueLine(width, [
          { label: 'messages', value: String(this._messages.length), valueColor: C.value },
          { label: 'high', value: String(highCount), valueColor: highCount > 0 ? C.high : C.dim },
          { label: 'low', value: String(lowCount), valueColor: lowCount > 0 ? C.low : C.dim },
        ], C),
        buildKeyValueLine(width, [
          { label: 'system route', value: ui.systemMessages, valueColor: C.info },
          { label: 'ops route', value: ui.operationalMessages, valueColor: C.info },
          { label: 'wrfc route', value: ui.wrfcMessages, valueColor: C.info },
        ], C),
        buildGuidanceLine(width, '/settings', 'adjust where operational and WRFC messages render across panels and conversation', C),
      ];

      const selected = this._messages[this.selectedIndex]!;
      const messageRows: Line[] = this._messages.map((entry, index) =>
        this.renderItem(entry, index, index === this.selectedIndex, width),
      );

      const postureSection: PanelWorkspaceSection = { lines: buildSummaryBlock(width, 'System posture', postureLines, C) };
      const detailSection: PanelWorkspaceSection = {
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
      };
      const messagesSection = resolvePrimaryScrollableSection(width, height, {
        intro,
        palette: C,
        beforeSections: [postureSection],
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
        postureSection,
        messagesSection.section,
        detailSection,
      ];
      this.needsRender = false;
      const lines = buildPanelWorkspace(width, height, {
        title: 'System Messages',
        intro,
        sections,
        footerLines: [
          buildPanelLine(width, [['  j/k or Up/Down scroll  PgUp/PgDn page  g/G jump', C.dim]]),
        ],
        palette: C,
      });
      return lines;
    });
  }
}
