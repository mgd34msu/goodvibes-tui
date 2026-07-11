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

  test('summarizes state counts and lists flags as feature units', () => {
    const text = formatFlagsOverview([
      entry('alpha', 'enabled'),
      entry('beta', 'disabled'),
      entry('gamma', 'disabled', { runtimeToggleable: false }),
      entry('delta', 'killed', { killReason: 'crash loop' }),
    ]);
    // State counts fold into the summary line; the body is grouped feature units.
    expect(text).toContain('Feature flags (4 total) — 1 enabled · 2 dark · 1 killed');
    expect(text).toContain('killed: crash loop');
    expect(text).toContain('runtime-toggleable');
    expect(text).toContain('startup-only');
    expect(text).toContain('/flags on <id>');
    // No flat state-bucket headers anymore.
    expect(text).not.toContain('Enabled (1):');
    expect(text).not.toContain('Disabled — built, dark');
  });

  test('presents each flag as a unit with its config-key summary and a /settings pointer', () => {
    // A real flag with config keys shows the keys it tunes; an unknown/no-config
    // flag is a bare toggle. exec-sandbox is a real flag hosted under Runtime & Data.
    const text = formatFlagsOverview([
      entry('exec-sandbox', 'disabled'),
      entry('bare-flag', 'enabled'),
    ]);
    expect(text).toContain('one feature unit');
    expect(text).toContain('tunes: sandbox.enabled');
    expect(text).toContain('(edit in /settings)');
    expect(text).toContain('no config keys — toggle only');
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
