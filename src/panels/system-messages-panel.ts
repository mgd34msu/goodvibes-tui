/**
 * SystemMessagesPanel — displays operational system messages routed away
 * from the main conversation.
 */

import { BasePanel } from './base-panel.ts';
import type { Line } from '../types/grid.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';
import { getConfigSnapshot } from '../config/index.ts';

const MAX_MESSAGES = 500;

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#00ffff',
  headerBg: '#0f172a',
  high: '#fbbf24',
  low: '#9ca3af',
  ts: '#6b7280',
} as const;

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

export class SystemMessagesPanel extends BasePanel {
  private _messages: SystemMessageEntry[] = [];
  private _lastVisibleIdx = 0;
  private _scrollOffset = 0;

  constructor() {
    super('system-messages', 'System Messages', 'J', 'monitoring');
  }

  push(text: string, priority: SystemMessagePriority): void {
    this._messages.push({ ts: Date.now(), text, priority });
    if (this._messages.length > MAX_MESSAGES) {
      this._messages.shift();
      if (this._lastVisibleIdx > 0) this._lastVisibleIdx--;
    }
    this._lastVisibleIdx = Math.max(0, this._messages.length - 1);
    this._scrollOffset = Math.max(0, this._messages.length - 1);
    this.markDirty();
  }

  get count(): number {
    return this._messages.length;
  }

  getMessages(): readonly SystemMessageEntry[] {
    return this._messages;
  }

  handleInput(key: string): boolean {
    const prev = this._lastVisibleIdx;
    switch (key) {
      case 'j':
      case '\x1b[B':
        this._lastVisibleIdx = Math.min(this._lastVisibleIdx + 1, Math.max(0, this._messages.length - 1));
        break;
      case 'k':
      case '\x1b[A':
        this._lastVisibleIdx = Math.max(this._lastVisibleIdx - 1, 0);
        break;
      case '\x1b[6~':
        this._lastVisibleIdx = Math.min(this._lastVisibleIdx + 20, Math.max(0, this._messages.length - 1));
        break;
      case '\x1b[5~':
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

  override render(width: number, height: number): Line[] {
    if (!this.canRenderNow()) {
      return Array.from({ length: height }, () => buildPanelLine(width, [['', C.dim]]));
    }

    const start = Date.now();
    const intro = 'Operational system traffic routed out of the main conversation to reduce noise and keep runtime status reviewable.';

    if (this._messages.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'System Messages',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No system messages yet.',
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
      this.reportRenderDuration(Date.now() - start);
      return lines;
    }

    const highCount = this._messages.filter((entry) => entry.priority === 'high').length;
    const lowCount = this._messages.length - highCount;
    const ui = getConfigSnapshot().ui;
    const summaryLines = [
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

    const bodyBudget = Math.max(4, height - 9);
    const window = getTrackedVisibleWindow(this._messages.length, this._lastVisibleIdx, bodyBudget, this._scrollOffset, 1);
    this._scrollOffset = window.start;
    const messageLines: Line[] = [];
    for (const entry of this._messages.slice(window.start, window.end)) {
      const prefix = `${fmtTime(entry.ts)}  `;
      const fg = entry.priority === 'high' ? C.high : C.low;
      const wrapped = buildBodyText(width, `${prefix}${entry.text}`, C, fg);
      messageLines.push(...wrapped);
    }
    if (window.start > 0 || window.end < this._messages.length) {
      messageLines.unshift(buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${this._messages.length}`, C.ts]]));
    }

    const sections: PanelWorkspaceSection[] = [
      { title: 'Summary', lines: summaryLines },
      { title: 'Messages', lines: messageLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'System Messages',
      intro,
      sections,
      footerLines: [
        buildPanelLine(width, [['  j/k or Up/Down scroll  PgUp/PgDn page  g/G jump', C.dim]]),
      ],
      palette: C,
    });
    this.reportRenderDuration(Date.now() - start);
    return lines;
  }
}
