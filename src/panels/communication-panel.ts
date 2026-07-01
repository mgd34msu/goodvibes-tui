import type { Line } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { UiCommunicationSnapshot, UiReadModel } from '../runtime/ui-read-models.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import {
  buildBodyText,
  buildDetailBlock,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusBadge,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
  type StatusBadgeKind,
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

function statusBadgeKind(status: CommunicationRecord['status']): StatusBadgeKind {
  return status === 'blocked' ? 'blocked' : status === 'delivered' ? 'completed' : 'running';
}

function fmtAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export class CommunicationPanel extends ScrollableListPanel<CommunicationRecord> {
  private readonly readModel?: UiReadModel<UiCommunicationSnapshot>;
  private readonly unsub: (() => void) | null;
  /** When true, the list is narrowed to blocked messages only (b toggles). */
  private blockedOnly = false;

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
    const records = this.readModel.getSnapshot().records;
    return this.blockedOnly ? records.filter((r) => r.status === 'blocked') : records;
  }

  protected override filterMatches(record: CommunicationRecord, q: string): boolean {
    return (record.content ?? '').toLowerCase().includes(q)
      || record.kind.toLowerCase().includes(q)
      || String(record.fromId ?? '').toLowerCase().includes(q)
      || String(record.toId ?? '').toLowerCase().includes(q);
  }

  public override handleInput(key: string): boolean {
    // `b` toggles the blocked-lanes-only view — guarded so it only acts when not
    // typing into the filter input.
    if (key === 'b' && !this.filterActive) {
      this.blockedOnly = !this.blockedOnly;
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    return super.handleInput(key);
  }

  protected renderItem(record: CommunicationRecord, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    const badge = buildStatusBadge(statusBadgeKind(record.status), record.status)[0]!;
    const route = truncateDisplay(`${record.fromId} → ${record.toId}`, 26);
    const contentWidth = Math.max(0, width - 50);
    // Blocked messages have no delivered content; surface the policy reason
    // inline so the most important detail (why a lane is blocked) is visible
    // without selecting the row.
    const tail = record.status === 'blocked' && record.reason
      ? { text: record.reason, fg: C.warn }
      : { text: record.content, fg: C.dim };
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [`${fmtAgo(record.timestamp)} `.padStart(5), C.dim, bg],
      [` ${badge.text} `.padEnd(12), badge.fg, bg],
      [`${record.kind} `.padEnd(9), C.info, bg],
      [`${route} `.padEnd(27), C.value, bg],
      [truncateDisplay(tail.text, contentWidth), tail.fg, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No structured communication recorded yet.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/orchestration', summary: 'review graphs and recursive agent activity that emit messages' },
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

    // Posture: blocked lanes / message flow surfaced first per the panel's purpose.
    const postureLines = (): Line[] => [
      buildPanelLine(width, [
        ['  ', C.label],
        ...buildStatusBadge('blocked', 'blocked', { count: snapshot.totalBlocked }),
        ['    ', C.dim],
        ...buildStatusBadge('completed', 'delivered', { count: snapshot.totalDelivered }),
        ['    ', C.dim],
        ...buildStatusBadge('running', 'sent', { count: snapshot.totalSent }),
        ...(this.blockedOnly ? ([['   (blocked-only view)', C.warn]] as Array<[string, string]>) : []),
      ]),
      snapshot.totalBlocked > 0
        ? buildPanelLine(width, [[`  ${snapshot.totalBlocked} message${snapshot.totalBlocked !== 1 ? 's' : ''} blocked by routing policy — press b to isolate blocked lanes.`, C.warn]])
        : buildGuidanceLine(width, '/orchestration', 'inspect recursive routing, message handoff, and broadcast posture', C),
    ];

    if (records.length === 0) {
      return this.renderList(width, height, {
        title: 'Communication Control Room',
        header: postureLines(),
        footer: [buildKeyboardHints(width, this.footerHints(false), C)],
      });
    }

    this.clampSelection();
    const visible = this.getVisibleItems();
    const selected = visible[this.selectedIndex];

    const detailLines: Line[] = [];
    if (selected) {
      detailLines.push(...buildDetailBlock(width, `Message · ${selected.kind}`, [
        buildKeyValueLine(width, [
          { label: 'status', value: selected.status, valueColor: selected.status === 'blocked' ? C.error : C.ok },
          { label: 'scope', value: selected.scope, valueColor: C.value },
          { label: 'when', value: `${fmtAgo(selected.timestamp)} ago`, valueColor: C.dim },
        ], C),
        buildKeyValueLine(width, [
          { label: 'from', value: `${selected.fromId} (${selected.fromRole ?? 'unknown'})`, valueColor: C.value },
          { label: 'to', value: `${selected.toId} (${selected.toRole ?? 'unknown'})`, valueColor: C.value },
        ], C),
        ...(selected.reason
          ? buildBodyText(width, `blocked: ${selected.reason}`, C, C.warn)
          : []),
        ...buildBodyText(width, selected.content, C, C.value),
      ], C));
    }

    return this.renderList(width, height, {
      title: 'Communication Control Room',
      header: postureLines(),
      footer: [...detailLines, buildKeyboardHints(width, this.footerHints(true), C)],
    });
  }

  // Context-aware hints: filter keys reflect filter state, `b` reflects the
  // blocked-only toggle, and the inspect hint only appears when rows exist.
  private footerHints(hasRows: boolean): Array<{ keys: string; label: string }> {
    const hints: Array<{ keys: string; label: string }> = [];
    if (hasRows) hints.push({ keys: '↑/↓', label: 'select' });
    hints.push({ keys: 'b', label: this.blockedOnly ? 'show all lanes' : 'blocked only' });
    if (this.filterActive) {
      hints.push({ keys: 'Esc', label: 'clear filter' });
    } else if (this.filterQuery) {
      hints.push({ keys: '/', label: 'edit filter' }, { keys: 'Esc', label: 'clear filter' });
    } else {
      hints.push({ keys: '/', label: 'filter' });
    }
    return hints;
  }
}
