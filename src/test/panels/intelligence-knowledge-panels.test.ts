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

describe('KnowledgeGraphPanel', () => {
  test('renders graph + memory command groups with a detail block', () => {
    const panel = new KnowledgeGraphPanel();
    const text = linesText(panel.render(W, H));
    expect(text).toContain('SDK Knowledge Graph');
    expect(text).toContain('/knowledge status');
    expect(text).toContain('/recall add');
    // Detail block for the selected (first) command.
    expect(text).toContain('embedding-provider readiness');
  });

  test('navigation moves the selection cursor into the memory group', () => {
    const panel = new KnowledgeGraphPanel();
    panel.render(W, H);
    // 6 graph commands; pressing up from index 0 wraps to the last memory command.
    expect(panel.handleInput('up')).toBe(true);
    const text = linesText(panel.render(W, H));
    expect(text).toContain('project-memory alias');
  });

  test('footer hints reference live keys', () => {
    const panel = new KnowledgeGraphPanel();
    const text = linesText(panel.render(W, H));
    expect(text).toContain('browse commands');
  });
});
