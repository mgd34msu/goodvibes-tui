import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
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
          title: 'Overview',
          lines: [
            buildPanelLine(width, [[` sent:${domain.totalSent} delivered:${domain.totalDelivered} blocked:${domain.totalBlocked}`, C.dim]]),
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
    const window = getTrackedVisibleWindow(records.length, this.selectedIndex, Math.max(4, height - 14), this.scrollOffset, 1);
    this.scrollOffset = window.start;
    const overviewLines: Line[] = [
      buildPanelLine(width, [[` sent:${domain.totalSent} delivered:${domain.totalDelivered} blocked:${domain.totalBlocked}`, C.dim]]),
    ];
    for (let absolute = window.start; absolute < window.end; absolute++) {
      const record = records[absolute]!;
      const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
      const color = record.status === 'blocked' ? C.error : record.status === 'delivered' ? C.ok : C.info;
      overviewLines.push(buildPanelLine(width, [
        [' ', C.label, bg],
        [record.status.padEnd(10), color, bg],
        [` ${record.kind.padEnd(10)}`, C.info, bg],
        [` ${truncateDisplay(`${record.fromId} -> ${record.toId}`, 28).padEnd(28)}`, C.value, bg],
        [` ${truncateDisplay(record.content, Math.max(0, width - 53))}`, C.dim, bg],
      ]));
    }
    if (records.length > window.count) {
      overviewLines.push(buildPanelLine(width, [[`  showing ${window.start + 1}-${window.end} of ${records.length}`, C.dim]]));
    }

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

    const sections: PanelWorkspaceSection[] = [
      { title: 'Recent Messages', lines: overviewLines },
      { title: 'Selected Message', lines: detailLines },
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Communication Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move through messages', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
