import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  selectBg: '#0f172a',
} as const;

export class CommunicationPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(store?: RuntimeStore) {
    super('communication', 'Communication', 'Y', 'monitoring');
    this.store = store;
    this.unsub = store ? store.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const records = this.records();
    if (records.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(records.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  private records() {
    if (!this.store) return [];
    const domain = this.store.getState().communication;
    return domain.recentRecordIds
      .map((id) => domain.records.get(id))
      .filter((record): record is NonNullable<typeof record> => record !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const intro = 'Structured agent communication, routing policy outcomes, and delivery status across orchestration trees.';
    const footerLines = [buildPanelLine(width, [['  Up/Down move through messages', C.dim]])];

    if (!this.store) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Communication Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' Runtime store not wired into this panel yet.',
            'This workspace needs the live runtime store before it can show communication history and policy outcomes.',
            [{ command: '/communication', summary: 'reopen the workspace from the shell-owned runtime' }],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const domain = this.store.getState().communication;
    const records = this.records();

    if (records.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Communication Control Room',
        intro,
        sections: [{
          title: 'Communication posture',
          lines: [
            buildKeyValueLine(width, [
              { label: 'sent', value: String(domain.totalSent), valueColor: domain.totalSent > 0 ? C.info : C.dim },
              { label: 'delivered', value: String(domain.totalDelivered), valueColor: domain.totalDelivered > 0 ? C.ok : C.dim },
              { label: 'blocked', value: String(domain.totalBlocked), valueColor: domain.totalBlocked > 0 ? C.error : C.dim },
            ], C),
            buildGuidanceLine(width, '/communication', 'review structured message flow, delivery posture, and blocked routing decisions', C),
            ...buildEmptyState(
              width,
              ' No structured communication recorded yet.',
              'Messages, escalations, findings, and handoffs will appear here once orchestration starts routing them through the communication policy.',
              [
                { command: '/orchestration', summary: 'review graphs and recursive agent activity' },
                { command: '/communication', summary: 'reopen this workspace once the runtime emits message traffic' },
              ],
              C,
            ),
          ],
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.selectedIndex = Math.min(this.selectedIndex, records.length - 1);
    const postureLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'sent', value: String(domain.totalSent), valueColor: domain.totalSent > 0 ? C.info : C.dim },
        { label: 'delivered', value: String(domain.totalDelivered), valueColor: domain.totalDelivered > 0 ? C.ok : C.dim },
        { label: 'blocked', value: String(domain.totalBlocked), valueColor: domain.totalBlocked > 0 ? C.error : C.dim },
        { label: 'selected', value: `${records[this.selectedIndex]?.fromId ?? 'n/a'} -> ${records[this.selectedIndex]?.toId ?? 'n/a'}`, valueColor: C.value },
      ], C),
      buildGuidanceLine(width, '/orchestration', 'inspect recursive routing, message handoff, and blocked broadcast posture', C),
    ];

    const selected = records[this.selectedIndex]!;
    const detailLines: Line[] = [
      buildPanelLine(width, [['  Route: ', C.label], [`${selected.scope} / ${selected.kind}`, C.value], ['  Status: ', C.label], [selected.status, selected.status === 'blocked' ? C.error : C.ok]]),
      buildPanelLine(width, [['  From: ', C.label], [selected.fromId, C.value], ['  To: ', C.label], [selected.toId, C.value]]),
      buildPanelLine(width, [['  Roles: ', C.label], [`${selected.fromRole ?? 'unknown'} -> ${selected.toRole ?? 'unknown'}`, C.dim]]),
    ];
    if (selected.reason) {
      detailLines.push(buildPanelLine(width, [['  Reason: ', C.label], [truncateDisplay(selected.reason, Math.max(0, width - 11)), C.warn]]));
    }
    detailLines.push(...buildBodyText(width, ` Content: ${selected.content}`, C));
    const postureSection: PanelWorkspaceSection = { title: 'Communication posture', lines: postureLines };
    const detailSection: PanelWorkspaceSection = { title: 'Selected Message', lines: detailLines };
    const rawOverviewLines: Line[] = records.map((record, absolute) => {
      const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
      const color = record.status === 'blocked' ? C.error : record.status === 'delivered' ? C.ok : C.info;
      return buildPanelLine(width, [
        [' ', C.label, bg],
        [record.status.padEnd(10), color, bg],
        [` ${record.kind.padEnd(10)}`, C.info, bg],
        [` ${truncateDisplay(`${record.fromId} -> ${record.toId}`, 28).padEnd(28)}`, C.value, bg],
        [` ${truncateDisplay(record.content, Math.max(0, width - 53))}`, C.dim, bg],
      ]);
    });
    const resolvedMessagesSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [postureSection],
      section: {
        title: 'Recent Messages',
        scrollableLines: rawOverviewLines,
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedMessagesSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      resolvedMessagesSection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Communication Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
