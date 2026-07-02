import { describe, expect, test } from 'bun:test';
import { IntelligencePanel } from '../../panels/intelligence-panel.ts';
import { KnowledgeGraphPanel } from '../../panels/knowledge-graph-panel.ts';
import type { UiIntelligenceSnapshot, UiReadModel } from '../../runtime/ui-read-models.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function makeIntelligenceModel(diagnostics: Map<string, unknown[]> = new Map(), overrides: Partial<UiIntelligenceSnapshot> = {}): UiReadModel<UiIntelligenceSnapshot> {
  const snapshot = {
    diagnosticsStatus: 'ready',
    symbolSearchStatus: 'ready',
    completionsStatus: 'ready',
    hoverStatus: 'ready',
    errorCount: 0,
    warningCount: 0,
    totalRequests: 0,
    avgLatencyMs: 0,
    hover: { active: false },
    diagnostics: diagnostics as never,
    ...overrides,
  } as UiIntelligenceSnapshot;
  return {
    getSnapshot: () => snapshot,
    subscribe: (_cb: () => void) => () => {},
  } as unknown as UiReadModel<UiIntelligenceSnapshot>;
}

const W = 100;
const H = 26;

describe('IntelligencePanel', () => {
  test('no read model: actionable empty state', () => {
    const panel = new IntelligencePanel();
    const text = linesText(panel.render(W, H));
    expect(text).toContain('Intelligence Control Room');
    expect(text).toContain('/intelligence review');
  });

  test('renders posture and diagnostics list', () => {
    const diagnostics = new Map<string, unknown[]>([
      ['src/a.ts', [
        { filePath: 'src/a.ts', line: 9, column: 4, severity: 'error', message: 'Type X is not assignable to Y', source: 'typescript', code: '2322' },
      ]],
      ['src/b.ts', [
        { filePath: 'src/b.ts', line: 1, column: 0, severity: 'warning', message: 'Unused import', source: 'eslint' },
      ]],
    ]);
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 1, warningCount: 1 }));
    const text = linesText(panel.render(W, H));
    expect(text).toContain('diagnostics ready');
    expect(text).toContain('Diagnostics (2)');
    expect(text).toContain('src/a.ts');
    // Drill-down detail for the selected (error-first) file shows the finding.
    expect(text).toContain('Type X is not assignable');
    expect(text).toContain('10:5');
  });

  test('up/down navigation moves selection and updates detail', () => {
    const diagnostics = new Map<string, unknown[]>([
      ['src/a.ts', [{ filePath: 'src/a.ts', line: 0, column: 0, severity: 'error', message: 'alpha error', source: 'typescript' }]],
      ['src/b.ts', [{ filePath: 'src/b.ts', line: 0, column: 0, severity: 'error', message: 'beta error', source: 'typescript' }]],
    ]);
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 2 }));
    panel.render(W, H);
    expect(panel.handleInput('down')).toBe(true);
    const text = linesText(panel.render(W, H));
    expect(text).toContain('beta error');
  });

  test('degraded posture surfaces recovery guidance', () => {
    const panel = new IntelligencePanel(makeIntelligenceModel(new Map(), { symbolSearchStatus: 'degraded' }));
    const text = linesText(panel.render(W, H));
    expect(text).toContain('Recovery');
    expect(text).toContain('/intelligence repair');
  });

  test('render returns exactly H lines of W cells', () => {
    const panel = new IntelligencePanel(makeIntelligenceModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });
});

function makeKnowledgeApi(overrides: {
  sources?: unknown[];
  nodes?: unknown[];
  issues?: unknown[];
  schedules?: unknown[];
} = {}) {
  const sources = overrides.sources ?? [];
  const nodes = overrides.nodes ?? [];
  const issues = overrides.issues ?? [];
  const schedules = overrides.schedules ?? [];
  return {
    sources: { list: (_limit?: number) => sources },
    graph: {
      nodes: { list: (_limit?: number) => nodes },
      issues: {
        list: (_limit?: number) => issues,
        review: async (input: { issueId: string; action: string }) => ({
          ok: true as const,
          issue: { ...(issues.find((i) => (i as { id: string }).id === input.issueId) as object ?? {}), status: 'resolved' },
        }),
      },
      items: { search: (_query: string, _limit?: number) => [] },
    },
    jobs: { schedules: { list: (_limit?: number) => schedules } },
  } as unknown as import('@pellux/goodvibes-sdk/platform/knowledge').KnowledgeApi;
}

describe('KnowledgeGraphPanel', () => {
  test('empty graph: honest empty state with a single enabling command', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi());
    const text = linesText(panel.render(W, H));
    expect(text).toContain('No ingested knowledge yet.');
    expect(text).toContain('/knowledge ingest-url');
    // Only one enabling command mention — no full command catalogue.
    expect(text).not.toContain('/recall add');
    expect(text).not.toContain('/knowledge packet');
  });

  test('ingested graph: live node/source/issue counts render, not a command list', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      sources: [{ id: 'src_1', connectorId: 'url', sourceType: 'url', title: 'Doc one', status: 'indexed', tags: [], metadata: {}, createdAt: 0, updatedAt: 0 }],
      nodes: [{ id: 'node_1', kind: 'topic', slug: 'n1', title: 'Node one', aliases: [], status: 'active', confidence: 70, metadata: {}, createdAt: 0, updatedAt: 0 }],
      issues: [{ id: 'issue_1', severity: 'error', code: 'broken-link', message: 'Link is dead', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    const text = linesText(panel.render(W, H));
    expect(text).toContain('sources');
    expect(text).toContain('Doc one');
    expect(text).not.toContain('/knowledge status');
  });

  test('Tab enters the review-queue mode and back', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      issues: [{ id: 'issue_1', severity: 'warning', code: 'stale-source', message: 'stale', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    panel.render(W, H);
    expect(panel.handleInput('tab')).toBe(true);
    const reviewText = linesText(panel.render(W, H));
    expect(reviewText).toContain('Review Queue');
    expect(reviewText).toContain('stale-source');
    expect(panel.handleInput('tab')).toBe(true);
    const browseText = linesText(panel.render(W, H));
    expect(browseText).toContain('Browse');
  });

  test('M opens the memory panel via the injected callback instead of a dead hint', () => {
    let opened = false;
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi(), () => { opened = true; });
    panel.render(W, H);
    expect(panel.handleInput('M')).toBe(true);
    expect(opened).toBe(true);
  });

  test('review actions are ConfirmState-gated (y/n mirrors MemoryPanel)', () => {
    const panel = new KnowledgeGraphPanel(makeKnowledgeApi({
      issues: [{ id: 'issue_1', severity: 'warning', code: 'stale-source', message: 'stale', status: 'open', metadata: {}, createdAt: 0, updatedAt: 0 }],
    }));
    panel.render(W, H);
    panel.handleInput('tab');
    panel.render(W, H);
    expect(panel.handleInput('r')).toBe(true); // stage resolve
    const confirmText = linesText(panel.render(W, H));
    expect(confirmText).toContain('Resolve');
    expect(panel.handleInput('n')).toBe(true); // cancel — no crash, returns to review list
    const afterCancel = linesText(panel.render(W, H));
    expect(afterCancel).toContain('Review Queue');
  });
});
