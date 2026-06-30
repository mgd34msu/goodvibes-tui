import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiCommunicationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import { createEmptyLine } from '../types/grid.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  selectBg: '#0f172a',
} as const;

type CommunicationRecord = UiCommunicationSnapshot['records'][number];

export class CommunicationPanel extends ScrollableListPanel<CommunicationRecord> {
  private readonly readModel?: UiReadModel<UiCommunicationSnapshot>;
  private readonly unsub: (() => void) | null;

  public constructor(readModel?: UiReadModel<UiCommunicationSnapshot>) {
    super('communication', 'Communication', 'Y', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter messages';
    this.readModel = readModel;
    this.unsub = readModel ? readModel.subscribe(() => this.markDirty()) : null;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly CommunicationRecord[] {
    if (!this.readModel) return [];
    return this.readModel.getSnapshot().records;
  }

  protected override filterMatches(record: CommunicationRecord, q: string): boolean {
    return (record.content ?? '').toLowerCase().includes(q)
      || record.kind.toLowerCase().includes(q)
      || String(record.fromId ?? '').toLowerCase().includes(q)
      || String(record.toId ?? '').toLowerCase().includes(q);
  }

  protected renderItem(record: CommunicationRecord, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const color = record.status === 'blocked' ? C.error : record.status === 'delivered' ? C.ok : C.info;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [record.status.padEnd(10), color, bg],
      [` ${record.kind.padEnd(10)}`, C.info, bg],
      [` ${truncateDisplay(`${record.fromId} -> ${record.toId}`, 28).padEnd(28)}`, C.value, bg],
      [` ${truncateDisplay(record.content, Math.max(0, width - 53))}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No structured communication recorded yet.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/orchestration', summary: 'review graphs and recursive agent activity' },
      { command: '/communication', summary: 'reopen this workspace once the runtime emits message traffic' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Structured agent communication, routing policy outcomes, and delivery status across orchestration trees.';

    if (!this.readModel) {
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

    const snapshot = this.readModel.getSnapshot();
    const records = this.getItems();

    const postureLines: Line[] = [
      buildPanelLine(width, [['  Communication posture', C.label]]),
      buildKeyValueLine(width, [
        { label: 'sent', value: String(snapshot.totalSent), valueColor: snapshot.totalSent > 0 ? C.info : C.dim },
        { label: 'delivered', value: String(snapshot.totalDelivered), valueColor: snapshot.totalDelivered > 0 ? C.ok : C.dim },
        { label: 'blocked', value: String(snapshot.totalBlocked), valueColor: snapshot.totalBlocked > 0 ? C.error : C.dim },
      ], C),
      buildGuidanceLine(width, '/orchestration', 'inspect recursive routing, message handoff, and blocked broadcast posture', C),
    ];

    if (records.length === 0) {
      return this.renderList(width, height, {
        title: 'Communication Control Room',
        header: postureLines,
      });
    }

    this.clampSelection();
    const selected = records[this.selectedIndex];

    // Update posture with selected info
    const postureWithSelected: Line[] = [
      buildPanelLine(width, [['  Communication posture', C.label]]),
      buildKeyValueLine(width, [
        { label: 'sent', value: String(snapshot.totalSent), valueColor: snapshot.totalSent > 0 ? C.info : C.dim },
        { label: 'delivered', value: String(snapshot.totalDelivered), valueColor: snapshot.totalDelivered > 0 ? C.ok : C.dim },
        { label: 'blocked', value: String(snapshot.totalBlocked), valueColor: snapshot.totalBlocked > 0 ? C.error : C.dim },
        { label: 'selected', value: `${selected?.fromId ?? 'n/a'} -> ${selected?.toId ?? 'n/a'}`, valueColor: C.value },
      ], C),
      buildGuidanceLine(width, '/orchestration', 'inspect recursive routing, message handoff, and blocked broadcast posture', C),
    ];

    const footerLines: Line[] = [];
    if (selected) {
      footerLines.push(
        buildPanelLine(width, [['  Route: ', C.label], [`${selected.scope} / ${selected.kind}`, C.value], ['  Status: ', C.label], [selected.status, selected.status === 'blocked' ? C.error : C.ok]]),
        buildPanelLine(width, [['  From: ', C.label], [selected.fromId, C.value], ['  To: ', C.label], [selected.toId, C.value]]),
        buildPanelLine(width, [['  Roles: ', C.label], [`${selected.fromRole ?? 'unknown'} -> ${selected.toRole ?? 'unknown'}`, C.dim]]),
      );
      if (selected.reason) {
        footerLines.push(buildPanelLine(width, [['  Reason: ', C.label], [truncateDisplay(selected.reason, Math.max(0, width - 11)), C.warn]]));
      }
      footerLines.push(...buildBodyText(width, ` Content: ${selected.content}`, C));
    }
    footerLines.push(buildPanelLine(width, [['  Up/Down move through messages', C.dim]]));

    return this.renderList(width, height, {
      title: 'Communication Control Room',
      header: postureWithSelected,
      footer: footerLines,
    });
  }
}
