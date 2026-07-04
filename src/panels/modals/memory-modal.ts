import { MODAL_TONES } from './modal-theme.ts';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';

// ---------------------------------------------------------------------------
// Memory -> modal. WO-B (Wave-6): migrates MemoryPanel
// (src/panels/memory-panel.ts) to a BoundModalSurface. Two view modes (Tab
// toggles): 'all' the full record list with a local text filter, 'review'
// the operator review queue — same split as the panel.
//
// Review-state mutations (reviewed/stale/contradicted/fresh) and record
// delete are NOT called on the registry here — they route to the existing
// `/recall review` / `/recall remove` command path (charter: no destructive
// mutation direct-called from a modal builder, no confirm folded into a
// modal — the panel gated these behind a ConfirmState dialog, which this
// module does not reproduce).
//
// `memoryRegistry` is optional: absent when no project memory registry was
// wired at bootstrap. buildConfig then renders the same "not configured"
// copy `registerKnowledgePanels`'s `withUnconfiguredFallback` uses for the
// retired MemoryPanel (src/panels/builtin/knowledge.ts).
// ---------------------------------------------------------------------------

/** Minimal read shape of a `MemoryRecord` (`@pellux/goodvibes-sdk/platform/state` -> platform/state/memory-store.ts) this modal renders. */
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

/**
 * Live deps this modal reads. Structurally-narrowed slice of
 * `MemoryRegistry` (`@pellux/goodvibes-sdk/platform/state`) — only the two
 * read calls `MemoryPanel` makes (search, reviewQueue). `review`/`delete`
 * are intentionally excluded: those mutations route to `/recall review` /
 * `/recall remove` instead of being called from this module.
 */
export interface MemoryModalDeps {
  readonly memoryRegistry?: {
    search(filter?: { limit?: number }): readonly MemoryRecordLike[];
    reviewQueue(limit?: number): readonly MemoryRecordLike[];
  };
}

type FilterMode = 'all' | 'review';

// Mirrors registerKnowledgePanels's withUnconfiguredFallback copy for the
// retired MemoryPanel (src/panels/builtin/knowledge.ts) verbatim.
const NOT_CONFIGURED_TITLE = 'Memory registry not configured for this session.';
const NOT_CONFIGURED_BODY = 'This runtime was not wired with a project memory registry at bootstrap, so no memory data is available.';

function matchesQuery(record: MemoryRecordLike, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  const haystack = [record.summary, record.detail ?? '', record.cls, record.scope, record.tags.join(' ')].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Memory (project memory substrate) -> modal. 'all' mode lists every record
 * (filterable); 'review' mode narrows to the operator review queue. Both
 * modes share the same selection/detail machinery.
 */
export function bindMemoryModal(deps: MemoryModalDeps): BoundModalSurface {
  let mode: FilterMode = 'all';
  let allRecords: MemoryRecordLike[] = [];
  let reviewRecords: MemoryRecordLike[] = [];

  const refresh = (): void => {
    if (!deps.memoryRegistry) {
      allRecords = [];
      reviewRecords = [];
      return;
    }
    allRecords = [...deps.memoryRegistry.search({ limit: 100 })];
    reviewRecords = [...deps.memoryRegistry.reviewQueue(24)];
  };

  const activeRecords = (): MemoryRecordLike[] => (mode === 'review' ? reviewRecords : allRecords);
  const visibleRecords = (view: ModalViewState): MemoryRecordLike[] => activeRecords().filter((record) => matchesQuery(record, view.query));

  const selectedRecord = (view: ModalViewState): MemoryRecordLike | undefined => {
    const visible = visibleRecords(view);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const sections: ModalSection[] = [];

    if (!deps.memoryRegistry) {
      sections.push({ type: 'text', content: NOT_CONFIGURED_TITLE, style: { fg: MODAL_TONES.warn } });
      sections.push({ type: 'text', content: NOT_CONFIGURED_BODY, style: { dim: true } });
      return { title: 'Memory', width: 76, sections, footer: 'esc close' };
    }

    sections.push({
      type: 'text',
      content: `records ${allRecords.length}  review queue ${reviewRecords.length}`,
      style: { dim: true },
    });
    sections.push({ type: 'text', content: `mode: ${mode === 'review' ? 'Review Queue' : 'All Records'}  (tab toggles)` });
    sections.push({ type: 'separator' });

    const visible = visibleRecords(view);
    const selectedIdx = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
    const items: ModalListItem[] = visible.map((record, index) => ({
      label: mode === 'review'
        ? `${record.reviewState.padEnd(13)} ${String(record.confidence).padStart(3)}%  ${record.summary}`
        : `[${record.scope.slice(0, 1).toUpperCase()}/${record.cls.slice(0, 3).toUpperCase()}] ${record.id.slice(-8)}  ${fmtTime(record.createdAt)}  ${record.summary}`,
      selected: index === selectedIdx,
    }));
    if (items.length === 0) {
      sections.push({
        type: 'text',
        content: mode === 'review'
          ? 'No records in the review queue.'
          : (view.query ? `No matches for "${view.query}".` : 'No memory records.'),
        style: { dim: true },
      });
    } else {
      sections.push({ type: 'list', items });
    }

    const selected = selectedRecord(view);
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `scope ${selected.scope}  class ${selected.cls}  review ${selected.reviewState}  confidence ${selected.confidence}%`,
      });
      sections.push({ type: 'text', content: selected.summary });
      if (selected.detail) sections.push({ type: 'text', content: `detail: ${selected.detail}`, style: { dim: true } });
      if (selected.tags.length > 0) sections.push({ type: 'text', content: `tags: ${selected.tags.join(', ')}`, style: { dim: true } });
      if (selected.provenance.length > 0) {
        sections.push({
          type: 'text',
          content: `provenance: ${selected.provenance.map((p) => `${p.kind}:${p.ref}`).join('  ')}`,
          style: { dim: true },
        });
      }
      if (selected.staleReason) {
        sections.push({ type: 'text', content: `stale reason: ${selected.staleReason}`, style: { dim: true } });
      }
      if (selected.reviewedAt) {
        const reviewer = selected.reviewedBy ? ` by ${selected.reviewedBy}` : '';
        sections.push({ type: 'text', content: `reviewed: ${fmtTime(selected.reviewedAt)}${reviewer}`, style: { dim: true } });
      }
    }

    const hints = mode === 'review'
      ? ['up/down move', 'r/enter reviewed', 's stale', 'c contradicted', 'f fresh', 'd delete', 'tab all records']
      : ['up/down move', '/ filter', 'd delete', 'tab review queue'];

    return {
      title: 'Memory',
      width: 76,
      ...(mode === 'all' ? { search: view.query } : {}),
      sections,
      hints,
    };
  };

  const reviewCommand = (
    state: 'reviewed' | 'stale' | 'contradicted' | 'fresh',
    confidenceFor: (current: number) => number,
    reason?: string,
  ): ModalAction => (view) => {
    const record = selectedRecord(view);
    if (!record) return { kind: 'none' };
    const confidence = confidenceFor(record.confidence);
    const reasonFlag = reason ? ` --reason "${reason}"` : '';
    return { kind: 'runCommand', command: `/recall review ${record.id} ${state} --confidence ${confidence} --by operator${reasonFlag}` };
  };

  const remove: ModalAction = (view) => {
    const record = selectedRecord(view);
    if (!record) return { kind: 'none' };
    return { kind: 'runCommand', command: `/recall remove ${record.id}` };
  };

  return {
    name: 'memory',
    title: 'Memory',
    refresh,
    buildConfig,
    rowIds: (view) => visibleRecords(view).map((record) => record.id),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      toggleMode: () => {
        mode = mode === 'all' ? 'review' : 'all';
        return { kind: 'refresh' };
      },
      // Mirrors MemoryPanel.handleInput's review-mode confidence bumps
      // (r/Enter, s, c, f) exactly — see src/panels/memory-panel.ts:306-339.
      markReviewed: reviewCommand('reviewed', (c) => Math.max(c, 85)),
      markStale: reviewCommand('stale', (c) => Math.min(c, 40), 'marked stale from the memory panel'),
      markContradicted: reviewCommand('contradicted', () => 0, 'marked contradicted from the memory panel'),
      markFresh: reviewCommand('fresh', (c) => Math.max(c, 60)),
      remove,
    },
  };
}

/**
 * Deterministic golden fixture: fixed memory records with frozen createdAt
 * timestamps — no live registry, no wall-clock, no random ids — so the
 * rendered config is byte-stable across runs.
 */
export function memoryModalGoldenSurface(): BoundModalSurface {
  const FIXED_CREATED_AT = 1735689600000; // 2025-01-01T00:00:00.000Z
  const records: readonly MemoryRecordLike[] = [
    {
      id: 'mem-0000001a',
      scope: 'project',
      cls: 'decision',
      summary: 'Wave-6 batches panel retirements behind modal builders.',
      detail: 'Applies to KNOWLEDGE, MEMORY, WORK-PLAN in WO-B.',
      tags: ['wave-6', 'modals'],
      reviewState: 'reviewed',
      confidence: 90,
      reviewedAt: FIXED_CREATED_AT + 3600000,
      reviewedBy: 'operator',
      createdAt: FIXED_CREATED_AT,
      provenance: [{ kind: 'session', ref: 'session-fixed-1' }],
    },
    {
      id: 'mem-0000002b',
      scope: 'session',
      cls: 'risk',
      summary: 'Modal review actions must not call mutation APIs directly.',
      tags: ['charter'],
      reviewState: 'stale',
      confidence: 35,
      staleReason: 'needs re-verification against the charter doc',
      createdAt: FIXED_CREATED_AT + 86400000,
      provenance: [],
    },
  ];
  const surface = bindMemoryModal({
    memoryRegistry: {
      search: () => records,
      reviewQueue: () => records.filter((record) => record.reviewState !== 'reviewed'),
    },
  });
  surface.refresh();
  return surface;
}
