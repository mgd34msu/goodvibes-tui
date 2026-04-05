import { beforeEach, describe, expect, test } from 'bun:test';
import { createPermissionSimulator, DivergenceDashboard } from '../../runtime/permissions/index.ts';
import { getPolicyRuntimeState, resetPolicyRuntimeStateForTests } from '../../runtime/permissions/policy-runtime.ts';
import { createUnsignedBundle } from '../../runtime/permissions/policy-loader.ts';
import type { PolicyBundlePayload } from '../../runtime/permissions/policy-loader.ts';
import { PolicyPanel } from '../../panels/policy-panel.ts';
import type { PolicyRule } from '../../runtime/permissions/types.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map(line => line.map(cell => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

function makeBundle(id: string, rules: PolicyRule[] = []) {
  const payload: PolicyBundlePayload = {
    version: 1,
    rules,
    description: `Test bundle ${id}`,
  };
  return createUnsignedBundle(id, payload);
}

describe('PolicyPanel', () => {
  beforeEach(() => {
    resetPolicyRuntimeStateForTests();
  });

  test('renders empty guidance when no bundles are loaded', () => {
    const state = getPolicyRuntimeState();
    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(100, 12));
    expect(text).toContain('No policy bundles loaded');
  });

  test('renders current candidate and governance gate state', () => {
    const state = getPolicyRuntimeState();
    const registry = state.getRegistry();
    registry.loadCandidate(makeBundle('policy-a'));
    registry.markSimulating();

    const simulator = createPermissionSimulator(
      { mode: 'default', rules: [] },
      { mode: 'default', rules: [] },
      'warn-on-divergence',
    );
    const dashboard = new DivergenceDashboard(simulator, 'warn-on-divergence');
    state.setDashboard(dashboard);

    const report = simulator.getDivergenceReport();
    const gate = dashboard.checkEnforceGate();
    registry.attachSimulationReport(report, gate);
    registry.promote(true);
    registry.loadCandidate(makeBundle('policy-b'));
    state.notify();

    const panel = new PolicyPanel(state);
    const text = linesText(panel.render(120, 20));
    expect(text).toContain('policy-a');
    expect(text).toContain('policy-b');
    expect(text).toContain('Governance Gate');
    expect(text).toContain('warn-on-divergence');
  });
});
