import { describe, expect, test } from 'bun:test';
import { buildReviewTask } from '../../agents/wrfc-reporting.ts';
import type { EngineerReport } from '../../agents/completion-report.ts';

function makeEngineerReport(overrides?: Partial<EngineerReport>): EngineerReport {
  return {
    version: 1,
    archetype: 'engineer',
    summary: 'Implemented the reviewer handoff and tightened provider diagnostics.',
    gatheredContext: ['src/agents/wrfc-controller.ts', 'src/providers/openai-compat.ts'],
    plannedActions: ['compact the reviewer brief', 'log provider-boundary failures with request ids'],
    appliedChanges: ['replaced the raw engineer JSON dump with a digest', 'normalized OpenAI-compatible error details'],
    filesCreated: [],
    filesModified: ['src/agents/wrfc-reporting.ts', 'src/providers/openai-compat.ts'],
    filesDeleted: [],
    decisions: [{ what: 'summarize file lists inline', why: 'reduce reviewer prompt size without hiding the touched files' }],
    issues: ['provider-side dashboards still need to be checked against local request ids'],
    uncertainties: ['confirm whether the upstream 200-only dashboard includes streamed failures'],
    ...overrides,
  };
}

describe('wrfc-reporting buildReviewTask', () => {
  test('builds a compact digest instead of embedding full JSON', () => {
    const task = buildReviewTask('wrfc-12345678', makeEngineerReport(), 9.5);

    expect(task).toContain('Engineer report digest:');
    expect(task).toContain('Files modified (2): src/agents/wrfc-reporting.ts, src/providers/openai-compat.ts');
    expect(task).toContain('Decisions:');
    expect(task).not.toContain('```json');
    expect(task).not.toContain('"filesModified"');
  });

  test('truncates large file and action lists in the digest', () => {
    const task = buildReviewTask('wrfc-12345678', makeEngineerReport({
      filesModified: [
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'src/d.ts',
        'src/e.ts',
        'src/f.ts',
        'src/g.ts',
        'src/h.ts',
        'src/i.ts',
      ],
      appliedChanges: [
        'change 1',
        'change 2',
        'change 3',
        'change 4',
        'change 5',
        'change 6',
        'change 7',
      ],
    }), 9.5);

    expect(task).toContain('Files modified (9): src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts, src/f.ts, src/g.ts, src/h.ts (+1 more)');
    expect(task).toContain('Applied changes:');
    expect(task).toContain('- (+1 more)');
  });
});
