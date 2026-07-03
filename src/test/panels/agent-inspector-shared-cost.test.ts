// ---------------------------------------------------------------------------
// agent-inspector-shared cost/pricing tests (WO-315) — summarizeAgentUsage
// and buildWrfcCostSegments must disclose an unpriced model rather than
// showing a fabricated $0.00.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { summarizeAgentUsage, buildWrfcCostSegments, formatAgentCost } from '../../panels/agent-inspector-shared.ts';

const PALETTE = { label: 'label-color', info: 'info-color' };

describe('summarizeAgentUsage', () => {
  test('returns null when there is no usage yet', () => {
    expect(summarizeAgentUsage({ model: 'claude-sonnet-4-6' })).toBeNull();
  });

  test('priced:true and a real cost for a known model', () => {
    const summary = summarizeAgentUsage({
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(summary).not.toBeNull();
    expect(summary!.priced).toBe(true);
    expect(summary!.cost).toBeCloseTo(18, 2); // $3 + $15 per 1M
  });

  test('priced:false when usage exists but the model is unknown to every pricing source', () => {
    const summary = summarizeAgentUsage({
      model: 'totally-unknown-model-xyz',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    expect(summary).not.toBeNull();
    expect(summary!.priced).toBe(false);
    expect(summary!.cost).toBe(0); // placeholder, not a real zero cost
  });
});

describe('buildWrfcCostSegments', () => {
  test('renders the formatted cost for a priced model', () => {
    const segments = buildWrfcCostSegments(
      { model: 'claude-sonnet-4-6', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      PALETTE,
      (n) => String(n),
    );
    expect(segments).not.toBeNull();
    const costText = segments!.find(([text]) => text === formatAgentCost(18))?.[0];
    expect(costText).toBeDefined();
  });

  test('renders "unpriced" instead of a fabricated $0.00 for an unknown model', () => {
    const segments = buildWrfcCostSegments(
      { model: 'totally-unknown-model-xyz', usage: { inputTokens: 1000, outputTokens: 500 } },
      PALETTE,
      (n) => String(n),
    );
    expect(segments).not.toBeNull();
    expect(segments!.some(([text]) => text === 'unpriced')).toBe(true);
    expect(segments!.some(([text]) => text === '$0.00')).toBe(false);
  });
});
