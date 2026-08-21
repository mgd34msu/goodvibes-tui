import { describe, expect, test } from 'bun:test';
import {
  formatTarget,
  parseCiTarget,
  renderReport,
  renderWatch,
  type CiReport,
  type CiWatchSubscription,
} from '@/input/commands/ci-runtime.ts';

describe('parseCiTarget', () => {
  test('parses a bare repo', () => {
    expect(parseCiTarget('owner/repo')).toEqual({ repo: 'owner/repo' });
  });

  test('parses a PR number suffix', () => {
    expect(parseCiTarget('owner/repo#123')).toEqual({ repo: 'owner/repo', prNumber: 123 });
  });

  test('parses a ref suffix', () => {
    expect(parseCiTarget('owner/repo@feature-branch')).toEqual({ repo: 'owner/repo', ref: 'feature-branch' });
  });

  test('returns null for an empty token', () => {
    expect(parseCiTarget('')).toBeNull();
    expect(parseCiTarget('   ')).toBeNull();
  });
});

describe('formatTarget', () => {
  test('bare repo', () => {
    expect(formatTarget({ repo: 'owner/repo' })).toBe('owner/repo');
  });
  test('with PR number takes priority over ref', () => {
    expect(formatTarget({ repo: 'owner/repo', ref: 'main', prNumber: 7 })).toBe('owner/repo#7');
  });
  test('with ref only', () => {
    expect(formatTarget({ repo: 'owner/repo', ref: 'main' })).toBe('owner/repo@main');
  });
});

function makeReport(overrides: Partial<CiReport> = {}): CiReport {
  return {
    repo: 'owner/repo',
    overall: 'passed',
    jobs: [],
    violations: [],
    checkedAt: 0,
    ...overrides,
  } as CiReport;
}

describe('renderReport', () => {
  test('lists every job individually, never a rollup summary alone', () => {
    const report = makeReport({
      overall: 'failed',
      jobs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'in_progress', conclusion: null },
      ] as CiReport['jobs'],
    });
    const text = renderReport(report);
    expect(text).toContain('CI FAILED for owner/repo');
    expect(text).toContain('- build: success');
    expect(text).toContain('- test: failure');
    expect(text).toContain('- lint: in_progress');
    expect(text).toContain('FAILING: test');
  });

  test('flags continue-on-error jobs and surfaces violations', () => {
    const report = makeReport({
      overall: 'failed',
      jobs: [
        { name: 'flaky', status: 'completed', conclusion: 'success', continueOnError: true },
      ] as CiReport['jobs'],
      violations: ['job "flaky" is continue-on-error, which is banned; it can mask a failure'],
    });
    const text = renderReport(report);
    expect(text).toContain('[continue-on-error]');
    expect(text).toContain('! job "flaky" is continue-on-error');
  });

  test('does not print a FAILING line when overall passed', () => {
    const report = makeReport({
      overall: 'passed',
      jobs: [{ name: 'build', status: 'completed', conclusion: 'success' }] as CiReport['jobs'],
    });
    expect(renderReport(report)).not.toContain('FAILING:');
  });
});

describe('renderWatch', () => {
  test('renders id, target, delivery channel, and fix-session opt-in', () => {
    const watch: CiWatchSubscription = {
      id: 'w1',
      repo: 'owner/repo',
      prNumber: 42,
      deliveryChannel: 'slack:C123',
      triggerFixSession: true,
      lastOverall: 'failed',
      createdAt: 0,
      updatedAt: 0,
    } as CiWatchSubscription;
    const text = renderWatch(watch);
    expect(text).toContain('w1');
    expect(text).toContain('owner/repo#42');
    expect(text).toContain('delivery: slack:C123');
    expect(text).toContain('fix-session on failure: yes');
    expect(text).toContain('last checked: failed');
  });
});
