/**
 * WO item 3, the always-visible footer shows the TRUE total (main session +
 * fleet), not the main session alone. A cold eval saw the footer read ~$0.046 (main
 * only) while a live WRFC chain cost ~$0.446 (~10x). We render an honest split,
 * "you ~$X · fleet ~$Y", so it is clear where the cost went.
 */
import { describe, test, expect } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { linesToText } from '../setup.ts';
import { fleetLeafCostTotal } from '../../panels/fleet-read-model.ts';
import type { ProcessNode } from '@pellux/goodvibes-sdk/platform/runtime/fleet';

const W = 140;
const PRICED_MODEL = 'claude-opus-4-6'; // real catalog pricing

function footerText(usage: { up: number; down: number; fleetCostUsd?: number | null }): string {
  return linesToText(UIFactory.createFooter(
    W, '> prompt', usage, false, 0, PRICED_MODEL, 5, undefined, '/proj', 'anthropic', 0,
  )).join('\n');
}

describe('footer cost: main + fleet split', () => {
  test('with a live fleet cost, the footer shows a "you … · fleet …" split', () => {
    const text = footerText({ up: 100_000, down: 20_000, fleetCostUsd: 0.446 });
    expect(text).toContain('you ~$');
    expect(text).toContain('fleet ~$0.446');
  });

  test('with no fleet cost, the footer is unchanged (single figure, no split)', () => {
    const text = footerText({ up: 100_000, down: 20_000, fleetCostUsd: null });
    expect(text).not.toContain('fleet ~$');
    expect(text).not.toContain('you ~$');
    expect(text).toContain('~$'); // the plain main-session figure is still there
  });

  test('a zero fleet cost does not render a fleet segment', () => {
    const text = footerText({ up: 100_000, down: 20_000, fleetCostUsd: 0 });
    expect(text).not.toContain('fleet ~$');
  });
});

function node(o: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent', label: o.id, state: 'executing-tool', elapsedMs: 0, costState: 'unpriced',
    capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: false }, ...o,
  };
}

describe('fleetLeafCostTotal: leaf-sum with no double-count', () => {
  test('sums priced leaf agents, excludes the owner rollup and the chain aggregate', () => {
    const nodes: ProcessNode[] = [
      node({ id: 'eng', costUsd: 0.3, costState: 'priced' }),
      node({ id: 'rev', costUsd: 0.146, costState: 'priced' }),
      // Owner: a rollup of its children (raw.wrfcRole==='owner'), must be excluded.
      node({ id: 'owner', costUsd: 0.446, costState: 'priced', raw: { wrfcRole: 'owner' } }),
      // Chain aggregate node, must be excluded.
      { ...node({ id: 'chain:c' }), kind: 'wrfc-chain', costUsd: 0.446, costState: 'priced' },
    ];
    expect(fleetLeafCostTotal(nodes)).toBeCloseTo(0.446, 6);
  });

  test('null when nothing is priced', () => {
    expect(fleetLeafCostTotal([node({ id: 'a' }), node({ id: 'b' })])).toBeNull();
  });
});
