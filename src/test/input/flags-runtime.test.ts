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
