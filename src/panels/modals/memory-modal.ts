import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';

// ---------------------------------------------------------------------------
// Memory → config-modal surface (W6.1 group-B port). Two tabs: 'All Records'
// (the full record list) and 'Review Queue' (the operator review queue) — the
// same split the panel toggled with Tab, now real host tabs. Review-state
// mutations (reviewed/stale/contradicted/fresh) and record delete route to the
// existing `/recall review` / `/recall remove` command path (charter: no
// destructive mutation direct-called from a modal). Selection-blind port: the
// panel's selected-record scope/class/tags/provenance detail is folded into
// each row label. `memoryRegistry` absent → the retired MemoryPanel's
// "not configured" copy renders as an honest degraded state.
// ---------------------------------------------------------------------------

/** Minimal read shape of a `MemoryRecord` this modal renders. */
interface MemoryRecordLike {
  readonly id: string;
  readonly scope: string;
  readonly cls: string;
  readonly summary: string;
  readonly detail?: string | undefined;
  readonly tags: readonly string[];
  readonly reviewState: string;
  readonly confidence: number;
  readonly staleReason?: string | undefined;
  readonly reviewedAt?: number | undefined;
  readonly reviewedBy?: string | undefined;
  readonly createdAt: number;
  readonly provenance: readonly { readonly kind: string; readonly ref: string }[];
}

export interface MemoryModalDeps {
  readonly memoryRegistry?: {
    search(filter?: { limit?: number }): readonly MemoryRecordLike[];
    reviewQueue(limit?: number): readonly MemoryRecordLike[];
  };
}

// Mirrors registerKnowledgePanels's withUnconfiguredFallback copy for the
// retired MemoryPanel (src/panels/builtin/knowledge.ts) verbatim.
const NOT_CONFIGURED_TITLE = 'Memory registry not configured for this session.';
const NOT_CONFIGURED_BODY = 'This runtime was not wired with a project memory registry at bootstrap, so no memory data is available.';

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

class MemoryModalSurface implements ConfigModalSurface {
  readonly name = 'memory-modal';
  readonly title = 'Memory';
  private allRecords: MemoryRecordLike[] = [];
  private reviewRecords: MemoryRecordLike[] = [];

  constructor(private readonly deps: MemoryModalDeps) {}

  private readonly reviewGate = (row: ConfigModalRow | null, tabId: string): boolean => tabId === 'review' && row !== null;

  readonly actions = [
    { key: 'enter', id: 'markReviewed', label: 'reviewed', enabledFor: this.reviewGate },
    { key: 's', id: 'markStale', label: 'stale', enabledFor: this.reviewGate },
    { key: 'c', id: 'markContradicted', label: 'contradicted', enabledFor: this.reviewGate },
    { key: 'f', id: 'markFresh', label: 'fresh', enabledFor: this.reviewGate },
    { key: 'd', id: 'remove', label: 'delete', enabledFor: (row: ConfigModalRow | null) => row !== null },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(): void { this.refresh(); }

  private refresh(): void {
    if (!this.deps.memoryRegistry) { this.allRecords = []; this.reviewRecords = []; return; }
    this.allRecords = [...this.deps.memoryRegistry.search({ limit: 100 })];
    this.reviewRecords = [...this.deps.memoryRegistry.reviewQueue(24)];
  }

  private recordFrom(id: string): MemoryRecordLike | undefined {
    return this.allRecords.find((r) => r.id === id) ?? this.reviewRecords.find((r) => r.id === id);
  }

  private allTab(): ConfigModalTab {
    const rows: ConfigModalRow[] = this.allRecords.map((record) => ({
      id: record.id,
      label: `[${record.scope.slice(0, 1).toUpperCase()}/${record.cls.slice(0, 3).toUpperCase()}] ${record.id.slice(-8)}  ${fmtTime(record.createdAt)}  ${record.summary}${record.tags.length > 0 ? `  #${record.tags.join(' #')}` : ''}`,
    }));
    return {
      id: 'all',
      label: 'All Records',
      header: [`records ${this.allRecords.length}  review queue ${this.reviewRecords.length}`],
      rows,
      emptyText: 'No memory records.',
      hints: ['d delete'],
    };
  }

  private reviewTab(): ConfigModalTab {
    const rows: ConfigModalRow[] = this.reviewRecords.map((record) => ({
      id: record.id,
      label: `${record.reviewState.padEnd(13)} ${String(record.confidence).padStart(3)}%  ${record.summary}${record.staleReason ? `  (stale: ${record.staleReason})` : ''}`,
    }));
    return {
      id: 'review',
      label: 'Review Queue',
      header: [`records ${this.allRecords.length}  review queue ${this.reviewRecords.length}`],
      rows,
      emptyText: 'No records in the review queue.',
      hints: ['enter reviewed', 's stale', 'c contradicted', 'f fresh', 'd delete'],
    };
  }

  buildView(): ConfigModalView {
    if (!this.deps.memoryRegistry) {
      return {
        title: 'Memory',
        degraded: `${NOT_CONFIGURED_TITLE} ${NOT_CONFIGURED_BODY}`,
        tabs: [{ id: 'all', label: 'All Records', rows: [] }],
      };
    }
    return { title: 'Memory', tabs: [this.allTab(), this.reviewTab()] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloaded memory records.'); return; }
    const record = ctx.row ? this.recordFrom(ctx.row.id) : undefined;
    if (!record) return;
    const review = (state: string, confidence: number, reason?: string): void => {
      const args = ['review', record.id, state, '--confidence', String(confidence), '--by', 'operator'];
      if (reason) args.push('--reason', reason);
      void ctx.executeCommand?.('recall', args);
      ctx.setStatus(`Dispatched /recall review ${record.id} ${state}.`);
    };
    switch (id) {
      case 'markReviewed': review('reviewed', Math.max(record.confidence, 85)); break;
      case 'markStale': review('stale', Math.min(record.confidence, 40), 'marked stale from the memory panel'); break;
      case 'markContradicted': review('contradicted', 0, 'marked contradicted from the memory panel'); break;
      case 'markFresh': review('fresh', Math.max(record.confidence, 60)); break;
      case 'remove': void ctx.executeCommand?.('recall', ['remove', record.id]); ctx.setStatus(`Dispatched /recall remove ${record.id}.`); break;
    }
  }
}

export function createMemoryModalSurface(deps: MemoryModalDeps): ConfigModalSurface {
  return new MemoryModalSurface(deps);
}

/**
 * Deterministic golden fixture: fixed memory records with frozen createdAt
 * timestamps — no live registry, no wall-clock, no random ids.
 */
export function memoryModalGoldenSurface(): ConfigModalSurface {
  const FIXED_CREATED_AT = 1735689600000; // 2025-01-01T00:00:00.000Z
  const records: readonly MemoryRecordLike[] = [
    {
      id: 'mem-0000001a', scope: 'project', cls: 'decision',
      summary: 'Wave-6 batches panel retirements behind modal builders.',
      detail: 'Applies to KNOWLEDGE, MEMORY, WORK-PLAN in WO-B.',
      tags: ['wave-6', 'modals'], reviewState: 'reviewed', confidence: 90,
      reviewedAt: FIXED_CREATED_AT + 3600000, reviewedBy: 'operator', createdAt: FIXED_CREATED_AT,
      provenance: [{ kind: 'session', ref: 'session-fixed-1' }],
    },
    {
      id: 'mem-0000002b', scope: 'session', cls: 'risk',
      summary: 'Modal review actions must not call mutation APIs directly.',
      tags: ['charter'], reviewState: 'stale', confidence: 35,
      staleReason: 'needs re-verification against the charter doc',
      createdAt: FIXED_CREATED_AT + 86400000, provenance: [],
    },
  ];
  return createMemoryModalSurface({
    memoryRegistry: {
      search: () => records,
      reviewQueue: () => records.filter((record) => record.reviewState !== 'reviewed'),
    },
  });
}
