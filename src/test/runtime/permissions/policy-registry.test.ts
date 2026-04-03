/**
 * Tests for PolicyRegistry — Section 5.3.
 *
 * Verifies the versioned bundle lifecycle:
 *   load → simulate → attach report → promote (gate check) → rollback
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { PolicyRegistry } from '../../../runtime/permissions/policy-registry.ts';
import { createUnsignedBundle } from '../../../runtime/permissions/policy-loader.ts';
import type { PolicyBundlePayload } from '../../../runtime/permissions/policy-loader.ts';
import type { DivergenceReport, DivergenceStats } from '../../../runtime/permissions/types.ts';
import type { EnforceGateResult } from '../../../runtime/permissions/divergence-dashboard.ts';
import type { PolicyRule } from '../../../runtime/permissions/types.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBundle(id: string, rules: PolicyRule[] = []) {
  const payload: PolicyBundlePayload = {
    version: 1,
    rules,
    description: `Test bundle ${id}`,
  };
  return createUnsignedBundle(id, payload);
}

function makeRule(id: string, effect: 'allow' | 'deny' = 'allow'): PolicyRule {
  return {
    type: 'prefix',
    id,
    description: `Rule ${id}`,
    origin: 'user',
    effect,
    toolPattern: '*',
    commandPrefixes: [],
  };
}

function emptyStats(totalEvaluations = 0): DivergenceStats {
  return {
    total: 0,
    byType: { 'allow-vs-deny': 0, 'deny-vs-allow': 0, 'reason-mismatch': 0 },
    divergenceRate: 0,
    totalEvaluations,
  };
}

function makeDivergenceReport(totalEvaluations = 100, totalDivergences = 0): DivergenceReport {
  const divergenceRate = totalEvaluations > 0 ? totalDivergences / totalEvaluations : 0;
  const overall: DivergenceStats = {
    total: totalDivergences,
    byType: {
      'allow-vs-deny': totalDivergences,
      'deny-vs-allow': 0,
      'reason-mismatch': totalEvaluations - totalDivergences,
    },
    divergenceRate,
    totalEvaluations,
  };
  return {
    overall,
    byToolClass: {},
    byCommandPrefix: {},
    byMode: {},
    records: [],
  };
}

function makeGateResult(status: 'allowed' | 'blocked' | 'no_data', rate?: number): EnforceGateResult {
  return {
    status,
    divergenceRate: rate,
    threshold: 0.05,
    totalEvaluations: status === 'no_data' ? 0 : 100,
    message: `Gate is ${status}`,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PolicyRegistry', () => {
  let registry: PolicyRegistry;

  beforeEach(() => {
    registry = new PolicyRegistry();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('has no current bundle', () => {
      expect(registry.getCurrent()).toBeNull();
    });

    it('has no candidate bundle', () => {
      expect(registry.getCandidate()).toBeNull();
    });

    it('has empty history', () => {
      expect(registry.getHistory()).toHaveLength(0);
    });

    it('diff returns null when no bundles loaded', () => {
      expect(registry.diff()).toBeNull();
    });
  });

  // ── loadCandidate ──────────────────────────────────────────────────────────

  describe('loadCandidate()', () => {
    it('loads a valid unsigned bundle as candidate in loaded state', () => {
      const bundle = makeBundle('bundle-1');
      const result = registry.loadCandidate(bundle);

      expect(result.ok).toBe(true);
      const candidate = registry.getCandidate();
      expect(candidate).not.toBeNull();
      expect(candidate!.bundle.bundleId).toBe('bundle-1');
      expect(candidate!.state).toBe('loaded');
    });

    it('replaces an existing candidate on second load', () => {
      registry.loadCandidate(makeBundle('bundle-a'));
      registry.loadCandidate(makeBundle('bundle-b'));

      expect(registry.getCandidate()!.bundle.bundleId).toBe('bundle-b');
    });

    it('returns rules from bundle payload', () => {
      const rules = [makeRule('r1'), makeRule('r2')];
      const bundle = makeBundle('with-rules', rules);
      const result = registry.loadCandidate(bundle);

      expect(result.rules).toHaveLength(2);
      expect(registry.getCandidate()!.rules).toHaveLength(2);
    });
  });

  // ── markSimulating ─────────────────────────────────────────────────────────

  describe('markSimulating()', () => {
    it('transitions candidate from loaded to simulating', () => {
      registry.loadCandidate(makeBundle('b1'));
      const ok = registry.markSimulating();

      expect(ok).toBe(true);
      expect(registry.getCandidate()!.state).toBe('simulating');
    });

    it('returns false when no candidate', () => {
      expect(registry.markSimulating()).toBe(false);
    });

    it('returns false when candidate is already simulating', () => {
      registry.loadCandidate(makeBundle('b1'));
      registry.markSimulating();
      expect(registry.markSimulating()).toBe(false);
    });
  });

  // ── attachSimulationReport ─────────────────────────────────────────────────

  describe('attachSimulationReport()', () => {
    it('attaches report and gate, transitions to promoting', () => {
      registry.loadCandidate(makeBundle('b1'));
      registry.markSimulating();

      const report = makeDivergenceReport(100, 0);
      const gate = makeGateResult('allowed');
      const ok = registry.attachSimulationReport(report, gate);

      expect(ok).toBe(true);
      const candidate = registry.getCandidate()!;
      expect(candidate.state).toBe('promoting');
      expect(candidate.simulationReport).toBeDefined();
      expect(candidate.gateResult).toBeDefined();
    });

    it('returns false when candidate is in loaded state', () => {
      registry.loadCandidate(makeBundle('b1'));
      const report = makeDivergenceReport();
      const gate = makeGateResult('allowed');
      expect(registry.attachSimulationReport(report, gate)).toBe(false);
    });

    it('returns false when no candidate', () => {
      const report = makeDivergenceReport();
      const gate = makeGateResult('allowed');
      expect(registry.attachSimulationReport(report, gate)).toBe(false);
    });
  });

  // ── promote ────────────────────────────────────────────────────────────────

  describe('promote()', () => {
    function loadAndSimulate(bundleId: string): void {
      registry.loadCandidate(makeBundle(bundleId));
      registry.markSimulating();
      registry.attachSimulationReport(
        makeDivergenceReport(100, 0),
        makeGateResult('allowed'),
      );
    }

    it('promotes candidate to active when gate passes', () => {
      loadAndSimulate('bundle-1');
      const result = registry.promote();

      expect(result.ok).toBe(true);
      expect(result.bundleId).toBe('bundle-1');
      expect(registry.getCurrent()?.state).toBe('active');
      expect(registry.getCandidate()).toBeNull();
    });

    it('archives previous active bundle to history on promotion', () => {
      loadAndSimulate('v1');
      registry.promote();

      loadAndSimulate('v2');
      registry.promote();

      expect(registry.getHistory()).toHaveLength(1);
      expect(registry.getHistory()[0].bundle.bundleId).toBe('v1');
    });

    it('blocks promotion when no candidate', () => {
      const result = registry.promote();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no candidate/i);
    });

    it('blocks promotion when candidate is in loaded state (no simulation)', () => {
      registry.loadCandidate(makeBundle('b1'));
      const result = registry.promote();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/simulate/i);
    });

    it('blocks promotion when gate is failing', () => {
      registry.loadCandidate(makeBundle('b1'));
      registry.markSimulating();
      registry.attachSimulationReport(
        makeDivergenceReport(100, 20),
        makeGateResult('blocked', 0.2),
      );

      const result = registry.promote();
      expect(result.ok).toBe(false);
      expect(result.gate?.status).toBe('blocked');
      expect(result.error).toMatch(/blocked/i);
    });

    it('force=true bypasses gate check', () => {
      registry.loadCandidate(makeBundle('b1'));
      registry.markSimulating();
      registry.attachSimulationReport(
        makeDivergenceReport(100, 30),
        makeGateResult('blocked', 0.3),
      );

      const result = registry.promote(true);
      expect(result.ok).toBe(true);
    });
  });

  // ── rollback ───────────────────────────────────────────────────────────────

  describe('rollback()', () => {
    function loadAndPromote(bundleId: string): void {
      registry.loadCandidate(makeBundle(bundleId));
      registry.markSimulating();
      registry.attachSimulationReport(
        makeDivergenceReport(100, 0),
        makeGateResult('allowed'),
      );
      registry.promote();
    }

    it('restores the previous active bundle', () => {
      loadAndPromote('v1');
      loadAndPromote('v2');

      const result = registry.rollback();
      expect(result.ok).toBe(true);
      expect(result.restoredBundleId).toBe('v1');
      expect(registry.getCurrent()?.bundle.bundleId).toBe('v1');
    });

    it('returns failure when no history', () => {
      loadAndPromote('v1');
      const result = registry.rollback();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no previous/i);
    });

    it('archives rolled-back bundle with rolled-back state', () => {
      loadAndPromote('v1');
      loadAndPromote('v2');
      registry.rollback();

      const history = registry.getHistory();
      const rolledBack = history.find((v) => v.bundle.bundleId === 'v2');
      expect(rolledBack?.state).toBe('rolled-back');
    });
  });

  // ── diff ───────────────────────────────────────────────────────────────────

  describe('diff()', () => {
    it('returns null when current or candidate is missing', () => {
      expect(registry.diff()).toBeNull();

      registry.loadCandidate(makeBundle('candidate'));
      expect(registry.diff()).toBeNull(); // no current yet
    });

    it('detects added rules', () => {
      // Promote v1 (empty rules) as current
      registry.loadCandidate(makeBundle('v1', []));
      registry.markSimulating();
      registry.attachSimulationReport(makeDivergenceReport(), makeGateResult('allowed'));
      registry.promote();

      // Load candidate with 2 new rules
      registry.loadCandidate(makeBundle('v2', [makeRule('new-1'), makeRule('new-2')]));

      const diff = registry.diff()!;
      expect(diff.added).toHaveLength(2);
      expect(diff.removed).toHaveLength(0);
      expect(diff.changed).toHaveLength(0);
      expect(diff.totalChanges).toBe(2);
    });

    it('detects removed rules', () => {
      registry.loadCandidate(makeBundle('v1', [makeRule('old-1'), makeRule('old-2')]));
      registry.markSimulating();
      registry.attachSimulationReport(makeDivergenceReport(), makeGateResult('allowed'));
      registry.promote();

      registry.loadCandidate(makeBundle('v2', []));

      const diff = registry.diff()!;
      expect(diff.removed).toHaveLength(2);
      expect(diff.added).toHaveLength(0);
      expect(diff.totalChanges).toBe(2);
    });

    it('detects changed rules', () => {
      registry.loadCandidate(makeBundle('v1', [makeRule('r1', 'allow')]));
      registry.markSimulating();
      registry.attachSimulationReport(makeDivergenceReport(), makeGateResult('allowed'));
      registry.promote();

      registry.loadCandidate(makeBundle('v2', [makeRule('r1', 'deny')]));

      const diff = registry.diff()!;
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0].ruleId).toBe('r1');
      expect(diff.changed[0].from.effect).toBe('allow');
      expect(diff.changed[0].to.effect).toBe('deny');
    });

    it('identifies unchanged rules', () => {
      const sharedRule = makeRule('shared');
      registry.loadCandidate(makeBundle('v1', [sharedRule]));
      registry.markSimulating();
      registry.attachSimulationReport(makeDivergenceReport(), makeGateResult('allowed'));
      registry.promote();

      registry.loadCandidate(makeBundle('v2', [sharedRule, makeRule('extra')]));

      const diff = registry.diff()!;
      expect(diff.unchanged).toHaveLength(1);
      expect(diff.added).toHaveLength(1);
    });
  });

  // ── history limit ──────────────────────────────────────────────────────────

  describe('history limit', () => {
    it('trims history to maxHistorySize', () => {
      const registry2 = new PolicyRegistry({ maxHistorySize: 3 });

      function loadAndPromote(id: string): void {
        registry2.loadCandidate(makeBundle(id));
        registry2.markSimulating();
        registry2.attachSimulationReport(makeDivergenceReport(), makeGateResult('allowed'));
        registry2.promote();
      }

      for (let i = 1; i <= 5; i++) {
        loadAndPromote(`v${i}`);
      }

      // v5 is current; history should have at most 3
      expect(registry2.getHistory()).toHaveLength(3);
    });
  });
});
