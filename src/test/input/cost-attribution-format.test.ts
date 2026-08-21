import { describe, expect, test } from 'bun:test';
import { formatCostAttributionSection, type CostAttributionResult } from '../../input/commands/cost-attribution-format.ts';

function makeResult(overrides: Partial<CostAttributionResult> = {}): CostAttributionResult {
  return {
    window: '24h',
    windowStartMs: Date.parse('2026-07-09T00:00:00Z'),
    dimension: 'agent',
    totalCostUsd: 1.2345,
    costState: 'priced',
    costSource: 'catalog',
    pricingAsOf: null,
    pricedRecordCount: 3,
    unpricedRecordCount: 0,
    tokens: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    rows: [],
    ...overrides,
  };
}

describe('formatCostAttributionSection', () => {
  test('optional dimension with no rows renders nothing; honest-empty, never a fabricated section', () => {
    const result = makeResult({ dimension: 'tool', rows: [] });
    expect(formatCostAttributionSection(result, true)).toBeNull();
  });

  test('primary dimension with no rows still renders, stating no records', () => {
    const result = makeResult({ dimension: 'agent', rows: [] });
    const lines = formatCostAttributionSection(result, false);
    expect(lines).not.toBeNull();
    expect(lines!.join('\n')).toContain('no attributed records');
  });

  test('a priced row shows a real dollar amount', () => {
    const result = makeResult({
      rows: [{ key: 'agent-1', costUsd: 0.5, costState: 'priced', costSource: 'catalog', pricingAsOf: null, pricedRecordCount: 1, unpricedRecordCount: 0, tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    });
    const text = formatCostAttributionSection(result, false)!.join('\n');
    expect(text).toContain('$0.5000');
    // The row itself never reads "unpriced", only the (accurate, 0-count) summary line does.
    const rowLine = formatCostAttributionSection(result, false)!.find((line) => line.includes('agent-1'));
    expect(rowLine).not.toContain('unpriced');
  });

  test('an estimated row is labeled estimated, never presented as a firm price', () => {
    const result = makeResult({
      costState: 'estimated',
      rows: [{ key: 'agent-1', costUsd: 0.5, costState: 'estimated', costSource: 'mixed', pricingAsOf: null, pricedRecordCount: 0, unpricedRecordCount: 1, tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    });
    const text = formatCostAttributionSection(result, false)!.join('\n');
    expect(text).toContain('$0.5000 (estimated)');
  });

  test('an unpriced row never fabricates a dollar amount', () => {
    const result = makeResult({
      totalCostUsd: null,
      costState: 'unpriced',
      rows: [{ key: 'unknown-model', costUsd: null, costState: 'unpriced', costSource: null, pricingAsOf: null, pricedRecordCount: 0, unpricedRecordCount: 1, tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }],
    });
    const text = formatCostAttributionSection(result, false)!.join('\n');
    expect(text).toContain('unpriced');
    expect(text).not.toMatch(/\$\d/);
  });
});
