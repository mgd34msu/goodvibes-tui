import { describe, test, expect } from 'bun:test';
import { createPolicyModalSurface, policyModalGoldenSurface } from '../../../panels/modals/policy-modal.ts';
import { actionCtx, captureCommands, open, tabText } from './modal-surface-test-helpers.ts';

describe('policy modal surface', () => {
  test('surface identity', () => {
    expect(createPolicyModalSurface({ policyRuntimeState: { getSnapshot: () => emptySnapshot() } }).name).toBe('policy-modal');
  });

  function emptySnapshot() {
    return { current: null, candidate: null, history: [], diff: null, divergence: null, recentPermissionAudit: [], lintFindings: [], lastSimulationSummary: null, lastPreflightReview: null, capturedAt: '2023-11-01T00:00:00.000Z' };
  }

  test('empty state names the honest reason and points at /policy load', () => {
    const view = open(createPolicyModalSurface({ policyRuntimeState: { getSnapshot: emptySnapshot } }));
    const text = tabText(view, 'governance');
    expect(text).toContain('No policy bundles loaded.');
    expect(text).toContain('/policy load');
    // Governance content view: no selectable rows.
    expect(view.tabs[0]!.rows.every((r) => r.selectable === false)).toBe(true);
  });

  test('golden fixture: bundles, diff, gate, history, audit, lint, preflight, and simulation all render', () => {
    const text = tabText(open(policyModalGoldenSurface()), 'governance');
    expect(text).toContain('Bundle bundle-current-1');
    expect(text).toContain('Bundle bundle-candidate-1');
    expect(text).toContain('bundle-current-1 -> bundle-candidate-1');
    expect(text).toContain('Governance Gate');
    expect(text).toContain('Gate blocked');
    expect(text).toContain('History');
    expect(text).toContain('bundle-prev-1');
    expect(text).toContain('Permission Audit');
    expect(text).toContain('blocked rm -rf outside sandbox root');
    expect(text).toContain('Policy Lint');
    expect(text).toContain('Preflight Review');
    expect(text).toContain('Simulation Samples');
    // Absolute formatted timestamps only.
    expect(text).toContain('Loaded 2023-11-01 00:00:00');
  });

  test('simulate/preflight/lint/promote/rollback all route to their /policy command path', () => {
    const surface = policyModalGoldenSurface();
    open(surface);
    for (const [id, sub] of [['simulate', 'simulate'], ['preflight', 'preflight'], ['lint', 'lint'], ['promote', 'promote'], ['rollback', 'rollback']] as const) {
      const cap = captureCommands();
      surface.onAction?.(id, actionCtx(null, cap.extra));
      expect(cap.calls).toEqual([['policy', [sub]]]);
    }
  });
});
