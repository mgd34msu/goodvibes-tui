import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalTab,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { memoryRecordTemporalStatus } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryConsolidationGatewayResolution, MemoryConsolidationProposal } from '../memory-consolidation-gateway.ts';
import { classifyConsolidationFetchError } from '../memory-consolidation-gateway.ts';

// ---------------------------------------------------------------------------
// Memory → config-modal surface (group-B port). Two tabs: 'All Records'
// (the full record list) and 'Review Queue' (the operator review queue) — the
// same split the panel toggled with Tab, now real host tabs. Review-state
// mutations (reviewed/stale/contradicted/fresh) and record delete route to the
// existing `/recall review` / `/recall remove` command path (charter: no
// destructive mutation direct-called from a modal). Selection-blind port: the
// panel's selected-record scope/class/tags/provenance detail is folded into
// each row label. `memoryRegistry` absent → the retired MemoryPanel's
// "not configured" copy renders as an honest degraded state.
//
// Read path (memory-spine adoption): reads go through the spine client's
// `honestSearch` — the MemoryAccess shape — not the raw registry, so a session
// that has adopted an external daemon reads the SAME wire-served records a
// wire failure is deliberately surfaced (never a silently stale local copy).
// `buildView()` stays synchronous/pure per the ConfigModalSurface contract;
// `refresh()` is async and calls the `requestRender` callback `onOpen` hands
// it when the data lands. The Review Queue ranking is recomputed client-side
// from the same honestSearch batch (see `rankForReview` below) rather than
// through a second wire call — `reviewQueue` is not part of MemoryAccess.
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
  readonly updatedAt?: number | undefined;
  readonly validFrom?: number | undefined;
  readonly validUntil?: number | undefined;
  readonly provenance: readonly { readonly kind: string; readonly ref: string }[];
}

/** Compact `[pending]`/`[expired]` suffix for a record row; empty for 'active' (no window, or currently inside it). */
function temporalSuffix(record: Pick<MemoryRecordLike, 'validFrom' | 'validUntil'>): string {
  const status = memoryRecordTemporalStatus(record);
  return status === 'active' ? '' : ` [${status}]`;
}

export interface MemoryModalDeps {
  readonly memoryRegistry?: {
    honestSearch(filter?: { limit?: number }): Promise<{
      readonly records: readonly MemoryRecordLike[];
      readonly indexUnavailableReason?: string | null | undefined;
    }>;
  };
  /**
   * Resolve the memory-consolidation-receipts gateway (memory-consolidation-gateway.ts),
   * lazily — called fresh each time the Proposals tab (re)fetches, exactly like
   * the Fleet panel's `resolveGateway` (fleet-gateway.ts / fleet-acts.ts). Absent
   * in a session with no daemon-backed control plane wired: the Proposals tab
   * then renders its "unavailable" honest state without ever attempting a fetch.
   */
  readonly resolveConsolidationGateway?: () => MemoryConsolidationGatewayResolution;
}

/** The Proposals tab's fetch state — one honest rendering per state, never a blend. */
type ProposalsStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly proposals: readonly MemoryConsolidationProposal[] };

/**
 * Client-side port of the SDK's MemoryStore.reviewQueue ranking
 * (memory-store-helpers.ts reviewQueueScore/isReviewCandidate): all four
 * review states are candidates, scored by state + inverse confidence (flagged
 * states penalized), tie-broken by recency. Presentation ordering only — not
 * a wire call, so exact parity with the server's own tie-breaking on ids it
 * has never seen is not load-bearing.
 */
function rankForReview(records: readonly MemoryRecordLike[], limit: number): MemoryRecordLike[] {
  const score = (r: MemoryRecordLike): number => {
    let s = 0;
    if (r.reviewState === 'fresh') s += 40;
    if (r.reviewState === 'stale') s += 20;
    if (r.reviewState === 'contradicted') s += 10;
    s += Math.max(0, 100 - r.confidence);
    if (r.reviewState === 'stale' || r.reviewState === 'contradicted') s -= 20;
    return s;
  };
  return [...records]
    .sort((a, b) => score(b) - score(a) || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) || b.createdAt - a.createdAt)
    .slice(0, limit);
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
  /** Honest note on the last read: a wire failure (client mode) or the index-unavailable fallback reason — never silently dropped. */
  private loadNote: string | null = null;
  /** The Proposals tab's fetch state — starts 'loading' whenever a gateway is wired (see refreshProposals). */
  private proposalsStatus: ProposalsStatus = { kind: 'loading' };
  private requestRender: (() => void) | null = null;

  constructor(private readonly deps: MemoryModalDeps) {}

  private readonly reviewGate = (row: ConfigModalRow | null, tabId: string): boolean => tabId === 'review' && row !== null;
  private readonly proposalsGate = (row: ConfigModalRow | null, tabId: string): boolean => tabId === 'proposals' && row !== null;

  readonly actions = [
    { key: 'enter', id: 'markReviewed', label: 'reviewed', enabledFor: this.reviewGate },
    { key: 's', id: 'markStale', label: 'stale', enabledFor: this.reviewGate },
    { key: 'c', id: 'markContradicted', label: 'contradicted', enabledFor: this.reviewGate },
    { key: 'f', id: 'markFresh', label: 'fresh', enabledFor: this.reviewGate },
    { key: 'd', id: 'remove', label: 'delete', enabledFor: (row: ConfigModalRow | null) => row !== null },
    { key: 'r', id: 'refresh', label: 'refresh' },
    // Jump from a selected proposal to one of its affected records in the
    // Review Queue tab. A DISTINCT key from 'enter' (not shared with
    // markReviewed): ConfigModal.resolveAction matches the FIRST action bound
    // to a key and returns null if THAT one's enabledFor fails, rather than
    // trying the next action bound to the same key — so gating two different
    // 'enter' actions by tabId alone would silently break one of them.
    { key: 'v', id: 'jumpToReviewQueue', label: 'view in review queue', enabledFor: this.proposalsGate },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    void this.refresh();
  }

  onClose(): void {
    this.requestRender = null;
  }

  private async refresh(): Promise<void> {
    await Promise.all([this.refreshRecords(), this.refreshProposals()]);
  }

  private async refreshRecords(): Promise<void> {
    if (!this.deps.memoryRegistry) { this.allRecords = []; this.reviewRecords = []; this.loadNote = null; return; }
    try {
      const result = await this.deps.memoryRegistry.honestSearch({ limit: 100 });
      this.allRecords = [...result.records];
      this.reviewRecords = rankForReview(result.records, 24);
      this.loadNote = result.indexUnavailableReason ?? null;
    } catch (error) {
      // Client-mode wire failure: surfaced plainly, never masked by the last-known list.
      this.loadNote = `Failed to reach memory over the wire: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.requestRender?.();
  }

  /**
   * Lazy fetch of memory.consolidation.receipts (memory-consolidation-gateway.ts)
   * — only attempted when this surface opens or refreshes, never polled. No
   * gateway resolver wired at all (session has no daemon-backed control
   * plane) renders the same honest "unavailable" state as a resolved-but-
   * refused gateway (daemon disabled / no control-plane URL) or a 501/404
   * from an older daemon with no consolidation scheduler — three different
   * causes, one bucket, because from the operator's seat they mean the same
   * thing: nothing to show, and no fault of theirs.
   */
  private async refreshProposals(): Promise<void> {
    if (!this.deps.resolveConsolidationGateway) {
      this.proposalsStatus = { kind: 'unavailable', reason: 'No consolidation gateway wired for this session.' };
      return;
    }
    this.proposalsStatus = { kind: 'loading' };
    this.requestRender?.();
    const resolution = this.deps.resolveConsolidationGateway();
    if (!resolution.available) {
      this.proposalsStatus = { kind: 'unavailable', reason: resolution.reason };
      return;
    }
    try {
      const result = await resolution.gateway.fetchReceipts();
      this.proposalsStatus = { kind: 'ready', proposals: result.pendingProposals };
    } catch (error) {
      this.proposalsStatus = classifyConsolidationFetchError(error);
    }
  }

  private recordFrom(id: string): MemoryRecordLike | undefined {
    return this.allRecords.find((r) => r.id === id) ?? this.reviewRecords.find((r) => r.id === id);
  }

  /** First pending proposal that names a given record id, keyed for the Review Queue's reason correlation (item 3). */
  private proposalsByRecordId(): Map<string, MemoryConsolidationProposal> {
    const map = new Map<string, MemoryConsolidationProposal>();
    if (this.proposalsStatus.kind !== 'ready') return map;
    for (const proposal of this.proposalsStatus.proposals) {
      for (const id of proposal.ids) if (!map.has(id)) map.set(id, proposal);
    }
    return map;
  }

  private allTab(): ConfigModalTab {
    const rows: ConfigModalRow[] = this.allRecords.map((record) => ({
      id: record.id,
      label: `[${record.scope.slice(0, 1).toUpperCase()}/${record.cls.slice(0, 3).toUpperCase()}] ${record.id.slice(-8)}  ${fmtTime(record.createdAt)}  ${record.summary}${record.tags.length > 0 ? `  #${record.tags.join(' #')}` : ''}${temporalSuffix(record)}`,
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
    const proposalByRecord = this.proposalsByRecordId();
    const rows: ConfigModalRow[] = this.reviewRecords.map((record) => {
      // A contradiction proposal already carries its reason on the record
      // itself (the daemon sets reviewState 'contradicted' + staleReason); a
      // cross-scope-duplicate proposal marks the record 'fresh' with NO
      // staleReason, so without this correlation those rows are bare and
      // unexplained (item 3) — fall back to the fetched proposal's own
      // reason only when the record didn't already carry one.
      const proposal = record.staleReason ? undefined : proposalByRecord.get(record.id);
      const reasonSuffix = record.staleReason
        ? `  (stale: ${record.staleReason})`
        : proposal
          ? `  (${proposal.kind}: ${proposal.reason})`
          : '';
      return {
        id: record.id,
        label: `${record.reviewState.padEnd(13)} ${String(record.confidence).padStart(3)}%  ${record.summary}${reasonSuffix}${temporalSuffix(record)}`,
      };
    });
    return {
      id: 'review',
      label: 'Review Queue',
      header: [`records ${this.allRecords.length}  review queue ${this.reviewRecords.length}`],
      rows,
      emptyText: 'No records in the review queue.',
      hints: ['enter reviewed', 's stale', 'c contradicted', 'f fresh', 'd delete'],
    };
  }

  /**
   * The Proposals tab — WHAT the daemon's idle-time consolidation pass
   * proposed (contradiction / cross-scope-duplicate / stale-delete) and is
   * holding for human judgment, read lazily over memory.consolidation.receipts
   * (memory-consolidation-gateway.ts). Three distinct honest states render as
   * three distinct lines — 'loading' / 'unavailable' / 'error' never collapse
   * into a shared "nothing to show" — plus the true empty state ('ready' with
   * zero proposals) which is a fourth, equally honest line.
   */
  private proposalsTab(): ConfigModalTab {
    const status = this.proposalsStatus;
    const header = [`pending proposals ${status.kind === 'ready' ? status.proposals.length : 0}`];
    if (status.kind === 'loading') {
      return { id: 'proposals', label: 'Proposals', header, rows: [], emptyText: 'Loading pending proposals…' };
    }
    if (status.kind === 'unavailable') {
      return { id: 'proposals', label: 'Proposals', header, rows: [], emptyText: `Pending proposals unavailable: ${status.reason}` };
    }
    if (status.kind === 'error') {
      return { id: 'proposals', label: 'Proposals', header, rows: [], emptyText: `Could not fetch pending proposals: ${status.message}` };
    }
    const rows: ConfigModalRow[] = status.proposals.map((proposal, index) => ({
      id: `proposal:${index}`,
      label: `[${proposal.kind}] ${proposal.reason}  — ${proposal.ids.length} record${proposal.ids.length === 1 ? '' : 's'}: ${proposal.ids.join(', ')}`,
    }));
    return {
      id: 'proposals',
      label: 'Proposals',
      header,
      rows,
      emptyText: 'No pending proposals — nothing awaiting judgment right now.',
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
    return {
      title: 'Memory',
      ...(this.loadNote ? { degraded: this.loadNote } : {}),
      tabs: [this.allTab(), this.reviewTab(), this.proposalsTab()],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { void this.refresh(); ctx.setStatus('Reloading memory records...'); return; }
    if (id === 'jumpToReviewQueue') { this.handleJumpToReviewQueue(ctx); return; }
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

  /**
   * The Proposals tab's "jump": move to the Review Queue tab with one of the
   * selected proposal's affected records selected — the same host mechanism
   * (`ctx.jumpToRow`) any future in-surface jump would use. A proposal's
   * `ids` are not guaranteed to all be inside the review queue's top-24
   * window, so this picks the first id that IS present there rather than
   * assuming the first id always is; when none are, it says so honestly
   * instead of jumping nowhere and leaving the user to wonder why.
   */
  private handleJumpToReviewQueue(ctx: ConfigModalActionContext): void {
    if (this.proposalsStatus.kind !== 'ready' || !ctx.row) return;
    const index = Number(ctx.row.id.slice('proposal:'.length));
    const proposal = this.proposalsStatus.proposals[index];
    if (!proposal) return;
    const target = proposal.ids.find((id) => this.reviewRecords.some((r) => r.id === id));
    if (!target) {
      ctx.setStatus(`None of this proposal's ${proposal.ids.length} record(s) are in the current review-queue window.`);
      return;
    }
    ctx.jumpToRow?.('review', target);
    ctx.setStatus(`Jumped to ${target} in the Review Queue.`);
  }
}

export function createMemoryModalSurface(deps: MemoryModalDeps): ConfigModalSurface {
  return new MemoryModalSurface(deps);
}

/**
 * Deterministic golden fixture: fixed memory records with frozen createdAt
 * timestamps — no live registry, no wall-clock, no random ids. Promise-backed
 * (see ecosystem-modals-golden.test.ts): `honestSearch` is async even for this
 * in-memory fixture (matching the real MemoryAccess shape), so the factory
 * pre-awaits the initial `onOpen` refresh before handing back the surface.
 */
export async function memoryModalGoldenSurface(): Promise<ConfigModalSurface> {
  const FIXED_CREATED_AT = 1735689600000; // 2025-01-01T00:00:00.000Z
  const records: readonly MemoryRecordLike[] = [
    {
      id: 'mem-0000001a', scope: 'project', cls: 'decision',
      summary: 'Panel retirements are batched behind modal builders.',
      detail: 'Applies to the knowledge, memory, and work-plan modals.',
      tags: ['panels', 'modals'], reviewState: 'reviewed', confidence: 90,
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
  const surface = createMemoryModalSurface({
    memoryRegistry: { honestSearch: async () => ({ records }) },
  });
  surface.onOpen?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
