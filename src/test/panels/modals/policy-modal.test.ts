import { describe, test, expect } from 'bun:test';
import { bindPolicyModal, policyModalGoldenSurface } from '../../../panels/modals/policy-modal.ts';
import { EMPTY_VIEW } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';

/** Flatten a ModalConfig's text/list/title content into one searchable string. Mirrors marketplace-modal.test.ts's helper. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

describe('policy modal builder', () => {
  test('empty state: no bundles loaded names the honest reason and points at /policy load', () => {
    const surface = bindPolicyModal({
      policyRuntimeState: {
        getSnapshot: () => ({
          current: null,
          candidate: null,
          history: [],
          diff: null,
          divergence: null,
          recentPermissionAudit: [],
          lintFindings: [],
          lastSimulationSummary: null,
          lastPreflightReview: null,
          capturedAt: '2023-11-01T00:00:00.000Z',
        }),
      },
    });
    surface.refresh();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No policy bundles loaded.');
    expect(text).toContain('/policy load');
    expect(surface.rowIds(EMPTY_VIEW)).toHaveLength(0);
  });

  test('golden fixture: current/candidate bundles, diff, and governance gate all render', () => {
    const surface = policyModalGoldenSurface();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Bundle bundle-current-1');
    expect(text).toContain('Bundle bundle-candidate-1');
    expect(text).toContain('bundle-current-1 -> bundle-candidate-1');
    expect(text).toContain('Governance Gate');
    expect(text).toContain('Gate blocked');
    expect(text).toContain('gate blocked');
  });

  test('golden fixture: history, permission audit, lint, preflight, and simulation sections all render', () => {
    const surface = policyModalGoldenSurface();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('History');
    expect(text).toContain('bundle-prev-1');
    expect(text).toContain('Permission Audit');
    expect(text).toContain('blocked rm -rf outside sandbox root');
    expect(text).toContain('Policy Lint');
    expect(text).toContain('toolPattern "Fetch"');
    expect(text).toContain('Preflight Review');
    expect(text).toContain('candidate rule broadens network access');
    expect(text).toContain('Simulation Samples');
    expect(text).toContain('fetch external API');
  });

  test('no wall-clock: two renders produce byte-identical config text', () => {
    const surface = policyModalGoldenSurface();
    const a = configText(surface.buildConfig(EMPTY_VIEW));
    const b = configText(surface.buildConfig(EMPTY_VIEW));
    expect(a).toBe(b);
    // Absolute formatted timestamps only, never a wall-clock relative string.
    expect(a).toContain('Loaded 2023-11-01 00:00:00');
  });

  test('simulate/preflight/lint/promote/rollback all route to their /policy command path (no modal-ized confirm)', () => {
    const surface = policyModalGoldenSurface();
    expect(surface.actions.simulate!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy simulate' });
    expect(surface.actions.preflight!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy preflight' });
    expect(surface.actions.lint!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy lint' });
    // Rollout maps to the registry's actual subcommand: promote.
    expect(surface.actions.promote!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy promote' });
    expect(surface.actions.rollback!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/policy rollback' });
  });

  test('no row-selectable list: rowIds is always empty', () => {
    const surface = policyModalGoldenSurface();
    expect(surface.rowIds(EMPTY_VIEW)).toEqual([]);
  });
});
