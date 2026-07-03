import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntelligencePanel } from '../../panels/intelligence-panel.ts';
import { KnowledgeGraphPanel } from '../../panels/knowledge-graph-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import type { PanelIntegrationContext } from '../../panels/types.ts';
import type { UiIntelligenceSnapshot, UiReadModel } from '../../runtime/ui-read-models.ts';
import type { Line } from '../../types/grid.ts';

/** A real, readable multi-line file — FilePreviewPanel.goToLine() clamps to fileLines.length, so a fake nonexistent path (1-line "(cannot open: ...)" placeholder) can't exercise a non-zero scroll offset. */
function makeReadableFile(lineCount = 20): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-intelligence-panel-'));
  const path = join(dir, 'sample.ts');
  writeFileSync(path, Array.from({ length: lineCount }, (_, i) => `line ${i}`).join('\n'));
  return path;
}

function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

/** Fake PanelManager exposing just the surface IntelligencePanel's cross-panel hook uses, backed by real FilePreviewPanel/SymbolOutlinePanel instances so `instanceof` checks pass. */
function makeFakePanelManager(): {
  panelManager: PanelIntegrationContext['panelManager'];
  preview: FilePreviewPanel;
  symbols: SymbolOutlinePanel;
} {
  const preview = new FilePreviewPanel();
  const symbols = new SymbolOutlinePanel();
  const panels: Record<string, FilePreviewPanel | SymbolOutlinePanel> = { preview, symbols };
  const panelManager = {
    getPanel: (id: string) => panels[id] ?? null,
    getPaneOf: (_id: string) => 'top' as const,
    activateById: (_id: string) => {},
    focusPane: (_pane: string) => {},
    isBottomPaneVisible: () => false,
    getFocusedPane: () => 'top' as const,
    open: (id: string) => panels[id] ?? null,
    show: () => {},
  } as unknown as PanelIntegrationContext['panelManager'];
  return { panelManager, preview, symbols };
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

  test('degraded posture surfaces a single-line contextual Recovery guidance (WO-136 collapse)', () => {
    const panel = new IntelligencePanel(makeIntelligenceModel(new Map(), { symbolSearchStatus: 'degraded' }));
    const text = linesText(panel.render(W, H));
    expect(text).toContain('Recovery');
    expect(text).toContain('/intelligence repair');
    const recoveryIdx = text.split('\n').findIndex((l) => l.includes('Recovery'));
    expect(recoveryIdx).toBeGreaterThan(-1);
    // Exactly one body line under the 'Recovery' section header, not the old 3-line wall.
    expect(text.split('\n')[recoveryIdx + 1]).toContain('/intelligence repair');
  });

  test('healthy posture surfaces a single-line contextual Workflows guidance (WO-136 collapse)', () => {
    const panel = new IntelligencePanel(makeIntelligenceModel());
    const text = linesText(panel.render(W, H));
    expect(text).toContain('Workflows');
    const workflowsIdx = text.split('\n').findIndex((l) => l.includes('Workflows'));
    expect(text.split('\n')[workflowsIdx + 1]).toContain('/intelligence symbols');
  });

  test('render returns exactly H lines of W cells', () => {
    const panel = new IntelligencePanel(makeIntelligenceModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
    for (const line of lines) expect(line).toHaveLength(W);
  });

  test('selection stays on-screen at End even with a small viewport (kills the old slice(0,6) cap)', () => {
    const diagnostics = new Map<string, unknown[]>();
    for (let i = 0; i < 12; i++) {
      const path = `src/file${String(i).padStart(2, '0')}.ts`;
      diagnostics.set(path, [{ filePath: path, line: 0, column: 0, severity: 'error', message: `error in ${path}`, source: 'typescript' }]);
    }
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 12 }));
    const smallHeight = 14;
    panel.render(W, smallHeight);
    expect(panel.handleInput('end')).toBe(true);
    const text = linesText(panel.render(W, smallHeight));
    // Last file, sorted alphabetically after the equal-severity tiebreak, must
    // be visible — a flat slice(0,6) would strand the cursor off-screen.
    expect(text).toContain('src/file11.ts');
  });

  test('Enter opens the selected file in the preview panel at its first (error-first) finding line', () => {
    const filePath = makeReadableFile();
    const diagnostics = new Map<string, unknown[]>([
      [filePath, [
        { filePath, line: 9, column: 4, severity: 'warning', message: 'warn finding', source: 'eslint' },
        { filePath, line: 2, column: 0, severity: 'error', message: 'error finding', source: 'typescript' },
      ]],
    ]);
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 1, warningCount: 1 }));
    panel.render(W, H);
    expect(panel.handleInput('enter')).toBe(true);

    const { panelManager, preview } = makeFakePanelManager();
    expect(panel.handlePanelIntegrationAction?.('enter', { panelManager })).toBe(true);
    expect(preview.getCurrentFilePath()).toBe(filePath);
    // Error-first: the error (0-indexed line 2) wins over the warning (line 9)
    // -> goToLine(3) -> scrollOffset = 3 - 1 = 2.
    expect(preview.getScrollOffset()).toBe(2);
  });

  test('s pivots to the Symbols panel, opening preview and loading the selected file source', () => {
    const filePath = makeReadableFile();
    const diagnostics = new Map<string, unknown[]>([
      [filePath, [{ filePath, line: 4, column: 0, severity: 'error', message: 'err', source: 'typescript' }]],
    ]);
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 1 }));
    panel.render(W, H);
    expect(panel.handleInput('s')).toBe(true);

    const { panelManager, preview, symbols } = makeFakePanelManager();
    const loadFileSpy = { called: false, path: '', source: null as string | null };
    symbols.loadFile = ((path: string, source: string) => {
      loadFileSpy.called = true;
      loadFileSpy.path = path;
      loadFileSpy.source = source;
    }) as typeof symbols.loadFile;

    expect(panel.handlePanelIntegrationAction?.('s', { panelManager })).toBe(true);
    expect(preview.getCurrentFilePath()).toBe(filePath);
    expect(loadFileSpy.called).toBe(true);
    expect(loadFileSpy.path).toBe(filePath);
    expect(loadFileSpy.source).toBe(preview.getSource());
  });

  test('findings are fully scrollable — no hardcoded 3-cap', () => {
    const findings = Array.from({ length: 6 }, (_, i) => ({
      filePath: 'src/a.ts',
      line: i,
      column: 0,
      severity: 'error',
      message: `finding number ${i}`,
      source: 'typescript',
    }));
    const diagnostics = new Map<string, unknown[]>([['src/a.ts', findings]]);
    const panel = new IntelligencePanel(makeIntelligenceModel(diagnostics, { errorCount: 6 }));
    const text = linesText(panel.render(W, 40));
    // All 6 findings fit in a tall viewport — a 3-cap would drop findings 4-6.
    for (let i = 0; i < 6; i++) {
      expect(text).toContain(`finding number ${i}`);
    }
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
