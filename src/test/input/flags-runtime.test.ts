import { describe, expect, test } from 'bun:test';
import { formatFlagsOverview, formatFlagsDoctor, type FlagSnapshotEntry } from '@/input/commands/flags-runtime.ts';
import type { FeatureFlag, FlagState } from '@/runtime/index.ts';

function flag(partial: Partial<FeatureFlag> & { id: string }): FeatureFlag {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    description: partial.description ?? `desc for ${partial.id}`,
    defaultState: partial.defaultState ?? 'disabled',
    tier: partial.tier ?? 1,
    runtimeToggleable: partial.runtimeToggleable ?? true,
    killReason: partial.killReason,
  } as FeatureFlag;
}

function entry(id: string, state: FlagState, extra: Partial<FeatureFlag> = {}): FlagSnapshotEntry {
  return { flag: flag({ id, ...extra }), state };
}

describe('formatFlagsOverview', () => {
  test('reports when no flags are registered', () => {
    expect(formatFlagsOverview([])).toContain('No feature flags are registered');
  });

  test('groups flags by state with counts', () => {
    const text = formatFlagsOverview([
      entry('alpha', 'enabled'),
      entry('beta', 'disabled'),
      entry('gamma', 'disabled', { runtimeToggleable: false }),
      entry('delta', 'killed', { killReason: 'crash loop' }),
    ]);
    expect(text).toContain('Feature flags (4 total)');
    expect(text).toContain('Enabled (1):');
    expect(text).toContain('Disabled — built, dark (2):');
    expect(text).toContain('Killed (1):');
    expect(text).toContain('killed: crash loop');
    expect(text).toContain('runtime-toggleable');
    expect(text).toContain('startup-only');
    expect(text).toContain('/flags on <id>');
  });

  test('shows (none) for empty groups and omits killed section when empty', () => {
    const text = formatFlagsOverview([entry('alpha', 'enabled')]);
    expect(text).toContain('Disabled — built, dark (0):');
    expect(text).toContain('(none)');
    expect(text).not.toContain('Killed');
  });
});

describe('formatFlagsDoctor', () => {
  test('reports clean when nothing is dark', () => {
    expect(formatFlagsDoctor([entry('alpha', 'enabled'), entry('beta', 'killed')]))
      .toContain('no dark subsystems');
  });

  test('lists disabled flags with the enable command', () => {
    const text = formatFlagsDoctor([
      entry('alpha', 'enabled'),
      entry('beta', 'disabled', { description: 'real subsystem' }),
      entry('gamma', 'disabled', { runtimeToggleable: false }),
    ]);
    expect(text).toContain('2 dark subsystems');
    expect(text).toContain('real subsystem');
    expect(text).toContain('enable now:   /flags on beta');
    expect(text).toContain('startup-only');
    expect(text).toContain('/flags on gamma');
    // Enabled flags are never listed as dark.
    expect(text).not.toContain('alpha');
  });

  test('uses singular wording for a single dark subsystem', () => {
    expect(formatFlagsDoctor([entry('beta', 'disabled')])).toContain('1 dark subsystem (built');
  });
});

import { formatGraduationReport } from '@/input/commands/flags-runtime.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

type GraduationReport = OperatorMethodOutput<'flags.graduation.report'>;
type GEntry = GraduationReport['entries'][number];

function gentry(partial: Partial<GEntry> & { flagId: string; state: GEntry['state'] }): GEntry {
  return {
    flagId: partial.flagId,
    name: partial.name ?? partial.flagId,
    tier: partial.tier ?? 1,
    currentDefault: partial.currentDefault ?? 'disabled',
    runtimeToggleable: partial.runtimeToggleable ?? true,
    state: partial.state,
    evidence: partial.evidence ?? { instrumentation: 'none', divergence: null, note: 'no evidence collected this run' },
    blocker: partial.blocker ?? null,
    note: partial.note ?? null,
  } as GEntry;
}

function report(entries: GEntry[], releaseBlockers: string[] = []): GraduationReport {
  const count = (s: GEntry['state']) => entries.filter((e) => e.state === s).length;
  return {
    generatedAt: 0,
    entries,
    summary: {
      total: entries.length,
      dark: count('dark'),
      soaking: count('soaking'),
      graduateCandidate: count('graduate-candidate'),
      graduated: count('graduated'),
      blocked: count('blocked'),
    },
    releaseBlockers,
  } as GraduationReport;
}

describe('formatGraduationReport', () => {
  test('sorts graduate-candidates first, under a release-blockers heading', () => {
    const text = formatGraduationReport(report([
      gentry({ flagId: 'zeta', state: 'graduated', currentDefault: 'enabled' }),
      gentry({
        flagId: 'alpha', state: 'graduate-candidate',
        evidence: { instrumentation: 'divergence-simulation', divergence: { divergenceRate: 0.004, totalEvaluations: 2000, gateStatus: 'allowed' }, note: 'ready' },
      }),
    ], ['alpha']));
    expect(text).toContain('RELEASE BLOCKERS (1)');
    // alpha (candidate) is rendered before zeta (graduated).
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('zeta'));
    expect(text).toContain('divergence 0.40% over 2000 evals, gate allowed');
    expect(text).toContain('All other flags:');
  });

  test('states "no evidence collected" plainly and reports no blockers when clear', () => {
    const text = formatGraduationReport(report([
      gentry({ flagId: 'dark-one', state: 'dark' }),
    ]));
    expect(text).toContain('No release blockers');
    expect(text).toContain('no evidence collected this run');
    expect(text).toContain('instrumentation: none');
  });

  test('renders a dated blocker reason for a blocked flag', () => {
    const text = formatGraduationReport(report([
      gentry({ flagId: 'held', state: 'blocked', blocker: { reason: 'perf regression', date: '2026-07-01' } }),
    ]));
    expect(text).toContain('blocked 2026-07-01: perf regression');
  });
});
