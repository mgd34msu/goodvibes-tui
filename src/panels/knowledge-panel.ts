import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { MemoryClass, MemoryRecord, MemoryRegistry, MemoryReviewState } from '../state/memory-store.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  good: '#22c55e',
  warn: '#eab308',
  bad: '#ef4444',
  info: '#38bdf8',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells = createEmptyLine(width);
  let col = 0;
  for (const [text, fg, bg] of segments) {
    for (const ch of text) {
      if (col >= width) return cells;
      cells[col++] = createStyledCell(ch, { fg, bg: bg ?? '' });
    }
  }
  while (col < width) {
    cells[col++] = createStyledCell(' ', { fg: '' });
  }
  return cells;
}

function summarize(records: MemoryRecord[], cls: MemoryClass): MemoryRecord[] {
  return records.filter((record) => record.cls === cls).slice(0, 3);
}

function reviewStateColor(state: MemoryReviewState): string {
  switch (state) {
    case 'reviewed':
      return C.good;
    case 'stale':
      return C.warn;
    case 'contradicted':
      return C.bad;
    case 'fresh':
    default:
      return C.info;
  }
}

function formatConfidence(confidence: number): string {
  return `${confidence.toString().padStart(3, ' ')}%`;
}

export class KnowledgePanel extends BasePanel {
  private readonly registry: MemoryRegistry;
  private unsubscribe?: () => void;
  private selectedIndex = 0;
  private records: MemoryRecord[] = [];

  public constructor(registry: MemoryRegistry) {
    super('knowledge', 'Knowledge', 'K', 'agent');
    this.registry = registry;
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
    this.unsubscribe = this.registry.subscribe(() => {
      this.refresh();
      this.markDirty();
    });
  }

  public override onDeactivate(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  public override onDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  public handleInput(key: string): boolean {
    if (this.records.length === 0) return false;
    if (key === 'ArrowUp' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'ArrowDown' || key === 'j') {
      this.selectedIndex = Math.min(this.records.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }

    const selected = this.records[this.selectedIndex];
    if (!selected) return false;

    if (key === 'Enter' || key === 'r') {
      this.registry.review(selected.id, {
        state: 'reviewed',
        confidence: Math.max(selected.confidence, 85),
        reviewedBy: 'operator',
      });
      this.refresh();
      this.markDirty();
      return true;
    }
    if (key === 's') {
      this.registry.review(selected.id, {
        state: 'stale',
        confidence: Math.min(selected.confidence, 40),
        reviewedBy: 'operator',
        staleReason: 'marked stale from the knowledge panel',
      });
      this.refresh();
      this.markDirty();
      return true;
    }
    if (key === 'c') {
      this.registry.review(selected.id, {
        state: 'contradicted',
        confidence: 0,
        reviewedBy: 'operator',
        staleReason: 'marked contradicted from the knowledge panel',
      });
      this.refresh();
      this.markDirty();
      return true;
    }
    if (key === 'f') {
      this.registry.review(selected.id, {
        state: 'fresh',
        confidence: Math.max(selected.confidence, 60),
        reviewedBy: 'operator',
      });
      this.refresh();
      this.markDirty();
      return true;
    }

    return false;
  }

  private refresh(): void {
    const queue = this.registry.reviewQueue(8);
    this.records = queue.length > 0 ? queue : this.registry.search({ limit: 8 });
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.records.length - 1));
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    if (this.records.length === 0) {
      this.refresh();
    }
    const lines: Line[] = [];
    const records = this.registry.search({ limit: 200 });
    const queue = this.registry.reviewQueue(8);
    const byClass = new Map<MemoryClass, number>();
    const byReview = new Map<MemoryReviewState, number>();
    for (const record of records) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
      byReview.set(record.reviewState, (byReview.get(record.reviewState) ?? 0) + 1);
    }

    lines.push(buildLine(width, [[' Knowledge Control Room', C.header, C.headerBg]]));
    lines.push(buildLine(width, [
      [' facts ', C.label], [String(byClass.get('fact') ?? 0), C.good],
      ['  risks ', C.label], [String(byClass.get('risk') ?? 0), (byClass.get('risk') ?? 0) > 0 ? C.warn : C.good],
      ['  runbooks ', C.label], [String(byClass.get('runbook') ?? 0), C.info],
      ['  architecture ', C.label], [String(byClass.get('architecture') ?? 0), C.info],
      ['  incidents ', C.label], [String(byClass.get('incident') ?? 0), (byClass.get('incident') ?? 0) > 0 ? C.bad : C.good],
    ]));
    lines.push(buildLine(width, [
      [' decisions ', C.label], [String(byClass.get('decision') ?? 0), C.value],
      ['  constraints ', C.label], [String(byClass.get('constraint') ?? 0), C.value],
      ['  ownership ', C.label], [String(byClass.get('ownership') ?? 0), C.value],
      ['  patterns ', C.label], [String(byClass.get('pattern') ?? 0), C.value],
      ['  total ', C.label], [String(records.length), C.value],
    ]));
    lines.push(buildLine(width, [
      [' reviewed ', C.label], [String(byReview.get('reviewed') ?? 0), C.good],
      ['  fresh ', C.label], [String(byReview.get('fresh') ?? 0), C.info],
      ['  stale ', C.label], [String(byReview.get('stale') ?? 0), C.warn],
      ['  contradicted ', C.label], [String(byReview.get('contradicted') ?? 0), C.bad],
      ['  review queue ', C.label], [String(queue.length), queue.length > 0 ? C.warn : C.good],
    ]));

    if (records.length === 0) {
      lines.push(buildLine(width, [[' No durable project knowledge has been recorded yet.', C.empty]]));
      lines.push(buildLine(width, [[' Use /recall add ... or /recall capture incident latest to populate the knowledge system.', C.dim]]));
      lines.push(buildLine(width, [[' Review keys: ↑↓ move  r/Enter review  s stale  c contradicted  f fresh', C.dim]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    lines.push(buildLine(width, [[' Review Queue', C.label]]));
    lines.push(buildLine(width, [['  ↑↓ move  r/Enter reviewed  s stale  c contradicted  f fresh', C.dim]]));

    const focusQueue = this.records.slice(0, Math.max(0, height - 12));
    for (let index = 0; index < focusQueue.length && lines.length < height - 6; index++) {
      const record = focusQueue[index]!;
      const bg = index === this.selectedIndex ? C.dim : undefined;
      const stateColor = reviewStateColor(record.reviewState);
      lines.push(buildLine(width, [
        ['  ', C.label, bg],
        [record.reviewState.padEnd(13), stateColor, bg],
        [` ${formatConfidence(record.confidence)} `, C.value, bg],
        [record.summary.slice(0, Math.max(0, width - 26)), C.value, bg],
      ]));
    }

    const selected = this.records[this.selectedIndex];
    if (selected) {
      lines.push(buildLine(width, [[' Selected', C.label]]));
      lines.push(buildLine(width, [
        ['  Class: ', C.label],
        [selected.cls, C.value],
        ['  Scope: ', C.label],
        [selected.scope, C.info],
        ['  Review: ', C.label],
        [selected.reviewState, reviewStateColor(selected.reviewState)],
        ['  Confidence: ', C.label],
        [formatConfidence(selected.confidence), C.value],
      ]));
      lines.push(buildLine(width, [
        ['  Summary: ', C.label],
        [selected.summary.slice(0, Math.max(0, width - 11)), C.value],
      ]));
      if (selected.detail) {
        lines.push(buildLine(width, [
          ['  Detail: ', C.label],
          [selected.detail.slice(0, Math.max(0, width - 10)), C.dim],
        ]));
      }
      if (selected.provenance.length) {
        lines.push(buildLine(width, [
          ['  Provenance: ', C.label],
          [selected.provenance.map((p) => `${p.kind}:${p.ref}`).join(', ').slice(0, Math.max(0, width - 14)), C.dim],
        ]));
      }
      if (selected.staleReason) {
        lines.push(buildLine(width, [
          ['  Stale reason: ', C.label],
          [selected.staleReason.slice(0, Math.max(0, width - 15)), selected.reviewState === 'contradicted' ? C.bad : C.warn],
        ]));
      }
      if (selected.reviewedAt) {
        lines.push(buildLine(width, [
          ['  Reviewed: ', C.label],
          [new Date(selected.reviewedAt).toLocaleString(), C.dim],
        ]));
        if (selected.reviewedBy) {
          lines.push(buildLine(width, [
            ['  Reviewer: ', C.label],
            [selected.reviewedBy, C.dim],
          ]));
        }
      }
    }

    const sections: Array<[string, MemoryRecord[], string]> = [
      ['Recent Risks', summarize(records, 'risk'), C.warn],
      ['Runbooks', summarize(records, 'runbook'), C.info],
      ['Architecture Notes', summarize(records, 'architecture'), C.info],
      ['Recent Incidents', summarize(records, 'incident'), C.bad],
    ];

    for (const [title, items, color] of sections) {
      if (lines.length >= height) break;
      lines.push(buildLine(width, [[` ${title}`, C.label]]));
      if (items.length === 0) {
        lines.push(buildLine(width, [['  none recorded', C.dim]]));
        continue;
      }
      for (const item of items) {
        if (lines.length >= height) break;
        lines.push(buildLine(width, [
          ['  ', C.label],
          [item.summary.slice(0, Math.max(0, width - 2)), color],
        ]));
      }
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
