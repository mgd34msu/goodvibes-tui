import type { Cell, Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  info: '#38bdf8',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  selectedBg: '#0f172a',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  for (const [text, fg, bg] of segments) {
    const style = { fg, bg: bg ?? '' };
    for (const ch of text) {
      if (cells.length >= width) break;
      cells.push(createStyledCell(ch, style));
    }
  }
  while (cells.length < width) cells.push(createStyledCell(' ', { fg: '' }));
  return cells.slice(0, width);
}

function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export class CommunicationPanel extends BasePanel {
  private readonly store?: RuntimeStore;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;

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
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Communication Control Room', C.header, C.headerBg]]));

    if (!this.store) {
      lines.push(buildLine(width, [[' Runtime store not wired into this panel yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const domain = this.store.getState().communication;
    const records = this.records();
    lines.push(buildLine(width, [[` sent:${domain.totalSent} delivered:${domain.totalDelivered} blocked:${domain.totalBlocked}`, C.dim]]));

    if (records.length === 0) {
      lines.push(buildLine(width, [[' No structured communication recorded yet.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    this.selectedIndex = Math.min(this.selectedIndex, records.length - 1);
    const visible = records.slice(0, Math.max(1, height - 8));
    for (let i = 0; i < visible.length; i++) {
      const record = visible[i]!;
      const bg = i === this.selectedIndex ? C.selectedBg : undefined;
      const color = record.status === 'blocked' ? C.error : record.status === 'delivered' ? C.ok : C.info;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [record.status.padEnd(10), color, bg],
        [` ${record.kind.padEnd(10)}`, C.info, bg],
        [` ${truncate(`${record.fromId} -> ${record.toId}`, 28).padEnd(28)}`, C.value, bg],
        [` ${truncate(record.content, Math.max(0, width - 53))}`, C.dim, bg],
      ]));
    }

    const selected = records[this.selectedIndex]!;
    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [['  Route: ', C.label], [`${selected.scope} / ${selected.kind}`, C.value], ['  Status: ', C.label], [selected.status, selected.status === 'blocked' ? C.error : C.ok]]));
    lines.push(buildLine(width, [['  From: ', C.label], [selected.fromId, C.value], ['  To: ', C.label], [selected.toId, C.value]]));
    lines.push(buildLine(width, [['  Roles: ', C.label], [`${selected.fromRole ?? 'unknown'} -> ${selected.toRole ?? 'unknown'}`, C.dim]]));
    if (selected.reason) {
      lines.push(buildLine(width, [['  Reason: ', C.label], [truncate(selected.reason, Math.max(0, width - 11)), C.warn]]));
    }
    lines.push(buildLine(width, [['  Content: ', C.label], [truncate(selected.content, Math.max(0, width - 12)), C.value]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
