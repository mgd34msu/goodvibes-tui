import { describe, expect, test } from 'bun:test';
import { buildReviewTask, parseReviewerCompletionReport } from '@pellux/goodvibes-sdk/platform/agents';
import type { EngineerReport } from '@pellux/goodvibes-sdk/platform/agents';

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
    const task = buildReviewTask('wrfc-12345678', 'Implement provider diagnostics', makeEngineerReport(), 9.5);

    expect(task).toContain('Original WRFC ask (authoritative full review scope):');
    expect(task).toContain('Implement provider diagnostics');
    expect(task).toContain('Engineer report digest:');
    expect(task).toContain('Files modified (2): src/agents/wrfc-reporting.ts, src/providers/openai-compat.ts');
    expect(task).toContain('Decisions:');
    expect(task).not.toContain('```json');
    expect(task).not.toContain('"filesModified"');
  });

  test('truncates large file and action lists in the digest', () => {
    const task = buildReviewTask('wrfc-12345678', 'Implement provider diagnostics', makeEngineerReport({
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

  test('includes full no-file reviewable output for reviewer validation', () => {
    const task = buildReviewTask('wrfc-12345678', 'Produce an assertion-based test plan', makeEngineerReport({
      filesModified: [],
      appliedChanges: [],
      reviewableOutput: [
        'Assertion-based test plan:',
        '- Capability A has a focused verification path.',
        '- Capability B has an observable failure check.',
      ].join('\n'),
    }), 9.5);

    expect(task).toContain('Engineer reviewable output');
    expect(task).toContain('Assertion-based test plan:');
    expect(task).toContain('Do not fail only because no files exist.');
  });

  test('normalizes common constraint finding evidence shapes instead of dropping findings', () => {
    const report = parseReviewerCompletionReport('wrfc-12345678', JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      score: 10,
      passed: true,
      dimensions: [],
      issues: [],
      constraintFindings: [
        {
          constraintId: 'must-review-full-output',
          satisfied: true,
          evidence: { summary: 'Reviewed the full non-file deliverable.' },
          severity: 'major',
        },
        {
          constraintId: 'must-verify-tests',
          satisfied: true,
          evidence: ['focused tests pass', 'no malformed findings dropped'],
        },
      ],
    }), 9.5);

    expect(report.constraintFindings).toHaveLength(2);
    expect(report.constraintFindings[0]?.evidence).toContain('Reviewed the full non-file deliverable');
    expect(report.constraintFindings[1]?.evidence).toContain('focused tests pass');
  });
});
