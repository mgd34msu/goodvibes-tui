import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import type { MemoryClass, MemoryRecord, MemoryRegistry, MemoryReviewState } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveScrollablePanelSection,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

function summarize(records: MemoryRecord[], cls: MemoryClass): MemoryRecord[] {
  return records.filter((record) => record.cls === cls).slice(0, 3);
}

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#94a3b8',
  headerBg: '#1e293b',
} as const;

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
  private scrollOffset = 0;
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
    super.onDeactivate();
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
    const queue = this.registry.reviewQueue(24);
    this.records = queue.length > 0 ? queue : this.registry.search({ limit: 24 });
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.records.length - 1));
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    if (this.records.length === 0) this.refresh();

    const intro = 'Typed project knowledge, reviewed evidence, and operator-governed memory across session, project, and team scopes.';
    const records = this.registry.search({ limit: 200 });

    if (records.length === 0) {
      return buildPanelWorkspace(width, height, {
        title: 'Knowledge Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No durable project knowledge has been recorded yet.',
            'The knowledge system is empty. It becomes useful once session, incident, task, and operator evidence are promoted into durable records.',
            [
              { command: '/recall add fact <summary>', summary: 'capture a durable fact directly' },
              { command: '/recall capture incident latest', summary: 'promote the latest incident into project memory' },
              { command: '/recall capture policy', summary: 'store the current policy posture as durable evidence' },
            ],
            C,
          ),
        }],
        footerLines: [
          buildPanelLine(width, [[' Review keys: Up/Down move  r/Enter review  s stale  c contradicted  f fresh', C.dim]]),
        ],
        palette: C,
      });
    }

    const queue = this.registry.reviewQueue(24);
    const byClass = new Map<MemoryClass, number>();
    const byReview = new Map<MemoryReviewState, number>();
    const byScope = new Map<string, number>();
    for (const record of records) {
      byClass.set(record.cls, (byClass.get(record.cls) ?? 0) + 1);
      byReview.set(record.reviewState, (byReview.get(record.reviewState) ?? 0) + 1);
      byScope.set(record.scope, (byScope.get(record.scope) ?? 0) + 1);
    }

    const classLines: Line[] = [
      buildPanelLine(width, [
        [' facts ', C.label], [String(byClass.get('fact') ?? 0), C.good],
        ['  risks ', C.label], [String(byClass.get('risk') ?? 0), (byClass.get('risk') ?? 0) > 0 ? C.warn : C.good],
        ['  runbooks ', C.label], [String(byClass.get('runbook') ?? 0), C.info],
        ['  architecture ', C.label], [String(byClass.get('architecture') ?? 0), C.info],
        ['  incidents ', C.label], [String(byClass.get('incident') ?? 0), (byClass.get('incident') ?? 0) > 0 ? C.bad : C.good],
      ]),
      buildPanelLine(width, [
        [' decisions ', C.label], [String(byClass.get('decision') ?? 0), C.value],
        ['  constraints ', C.label], [String(byClass.get('constraint') ?? 0), C.value],
        ['  ownership ', C.label], [String(byClass.get('ownership') ?? 0), C.value],
        ['  patterns ', C.label], [String(byClass.get('pattern') ?? 0), C.value],
        ['  total ', C.label], [String(records.length), C.value],
      ]),
    ];

    const reviewLines: Line[] = [
      buildPanelLine(width, [
        [' reviewed ', C.label], [String(byReview.get('reviewed') ?? 0), C.good],
        ['  fresh ', C.label], [String(byReview.get('fresh') ?? 0), C.info],
        ['  stale ', C.label], [String(byReview.get('stale') ?? 0), C.warn],
        ['  contradicted ', C.label], [String(byReview.get('contradicted') ?? 0), C.bad],
        ['  review queue ', C.label], [String(queue.length), queue.length > 0 ? C.warn : C.good],
      ]),
      buildPanelLine(width, [
        [' session ', C.label], [String(byScope.get('session') ?? 0), C.info],
        ['  project ', C.label], [String(byScope.get('project') ?? 0), C.value],
        ['  team ', C.label], [String(byScope.get('team') ?? 0), C.good],
      ]),
      buildGuidanceLine(width, '/recall review', 'work the stale and contradicted queue from the command surface', C),
    ];

    const recentSummaryLines: Line[] = [];
    for (const [title, items, color] of [
      ['Recent Risks', summarize(records, 'risk'), C.warn],
      ['Runbooks', summarize(records, 'runbook'), C.info],
      ['Architecture Notes', summarize(records, 'architecture'), C.info],
      ['Recent Incidents', summarize(records, 'incident'), C.bad],
    ] as const) {
      if (recentSummaryLines.length > 0) {
        recentSummaryLines.push(buildPanelLine(width, [['', C.dim]]));
      }
      recentSummaryLines.push(buildPanelLine(width, [[` ${title}`, C.label]]));
      if (items.length === 0) {
        recentSummaryLines.push(buildPanelLine(width, [['  none recorded', C.dim]]));
        continue;
      }
      for (const item of items) {
        recentSummaryLines.push(buildPanelLine(width, [
          ['  ', C.label],
          [item.summary.slice(0, Math.max(0, width - 2)), color],
        ]));
      }
    }

    const selected = this.records[this.selectedIndex];
    const selectedLines: Line[] = [];
    if (selected) {
      selectedLines.push(buildKeyValueLine(width, [
        { label: 'Class', value: selected.cls, valueColor: C.value },
        { label: 'Scope', value: selected.scope, valueColor: C.info },
        { label: 'Review', value: selected.reviewState, valueColor: reviewStateColor(selected.reviewState) },
        { label: 'Confidence', value: formatConfidence(selected.confidence), valueColor: C.value },
      ], C));
      selectedLines.push(...buildBodyText(width, `Summary: ${selected.summary}`, C, C.value));
      if (selected.detail) selectedLines.push(...buildBodyText(width, `Detail: ${selected.detail}`, C, C.dim));
      if (selected.provenance.length) {
        selectedLines.push(...buildBodyText(
          width,
          `Provenance: ${selected.provenance.map((p) => `${p.kind}:${p.ref}`).join(', ')}`,
          C,
          C.dim,
        ));
      }
      if (selected.staleReason) {
        selectedLines.push(...buildBodyText(
          width,
          `Stale reason: ${selected.staleReason}`,
          C,
          selected.reviewState === 'contradicted' ? C.bad : C.warn,
        ));
      }
      if (selected.reviewedAt) {
        selectedLines.push(buildPanelLine(width, [
          ['  Reviewed: ', C.label],
          [new Date(selected.reviewedAt).toLocaleString(), C.dim],
        ]));
        if (selected.reviewedBy) {
          selectedLines.push(buildPanelLine(width, [
            ['  Reviewer: ', C.label],
            [selected.reviewedBy, C.dim],
          ]));
        }
      }
    }

    const footerLines = [
      buildPanelLine(width, [['  Up/Down move  r/Enter reviewed  s stale  c contradicted  f fresh', C.dim]]),
    ];
    const classesSection: PanelWorkspaceSection = { title: 'Classes', lines: classLines };
    const reviewStateSection: PanelWorkspaceSection = { title: 'Review State', lines: reviewLines };
    const selectedSection: PanelWorkspaceSection = selectedLines.length > 0 ? { title: 'Selected', lines: selectedLines } : { title: 'Selected', lines: [] };
    const recentSection: PanelWorkspaceSection = { title: 'Recent Risks / Runbooks / Architecture Notes', lines: recentSummaryLines };
    const queueSection = resolveScrollablePanelSection(width, height, {
      intro,
      footerLines,
      palette: C,
      beforeSections: [classesSection, reviewStateSection],
      section: {
        title: 'Review Queue',
        scrollableLines: this.records.map((record, globalIndex) => {
          const bg = globalIndex === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            ['  ', C.label, bg],
            [record.reviewState.padEnd(13), reviewStateColor(record.reviewState), bg],
            [` ${formatConfidence(record.confidence)} `, C.value, bg],
            [record.summary.slice(0, Math.max(0, width - 26)), C.value, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: selectedLines.length > 0 ? [selectedSection, recentSection] : [recentSection],
    });
    this.scrollOffset = queueSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      classesSection,
      reviewStateSection,
      queueSection.section,
    ];
    if (selectedLines.length > 0) sections.push(selectedSection);
    sections.push(recentSection);

    return buildPanelWorkspace(width, height, {
      title: 'Knowledge Control Room',
      intro,
      sections,
      footerLines,
      palette: C,
    });
  }
}
