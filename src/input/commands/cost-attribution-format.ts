/**
 * cost-attribution-format.ts — pure rendering helpers for /cost attribution.
 *
 * cost.attribution.get (SDK 1.6.1) is honest-unpriced by design: an unknown
 * model contributes to unpricedRecordCount with a null cost rather than a
 * fabricated amount, and costState is 'priced' | 'estimated' | 'unpriced'
 * (a mix across contributors). These helpers preserve that distinction all
 * the way to the rendered line — "unpriced" always reads as unpriced,
 * "estimated" is always labeled, and a dollar figure only ever comes from a
 * real priced/estimated costUsd.
 */
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

export type CostAttributionResult = OperatorMethodOutput<'cost.attribution.get'>;
export type CostAttributionDimension = CostAttributionResult['dimension'];
export type CostWindow = CostAttributionResult['window'];

/** Dimensions always queried and rendered, even when empty (agent/model/provider are the headline breakdown). */
export const COST_ATTRIBUTION_PRIMARY_DIMENSIONS: readonly CostAttributionDimension[] = ['agent', 'model', 'provider'];

/**
 * Dimensions that exist on the wire but return honest-empty until their
 * emit sites tag records with this dimension. Queried the same as the
 * primary set, but rendered ONLY when non-empty — never a fabricated
 * "0 tool calls" section implying tool-level attribution works today.
 */
export const COST_ATTRIBUTION_OPTIONAL_DIMENSIONS: readonly CostAttributionDimension[] = ['tool', 'hook', 'mcp'];

function formatCostAmount(costUsd: number | null, costState: CostAttributionResult['costState']): string {
  if (costUsd === null || costState === 'unpriced') return 'unpriced';
  const amount = `$${costUsd.toFixed(4)}`;
  return costState === 'estimated' ? `${amount} (estimated)` : amount;
}

function formatTokens(tokens: CostAttributionResult['tokens']): string {
  return `in=${tokens.inputTokens} out=${tokens.outputTokens} cacheR=${tokens.cacheReadTokens} cacheW=${tokens.cacheWriteTokens}`;
}

/** Render one dimension's windowed attribution result as text lines, or null when it's an optional dimension with no rows yet. */
export function formatCostAttributionSection(result: CostAttributionResult, isOptional: boolean): string[] | null {
  if (isOptional && result.rows.length === 0) return null;
  const lines: string[] = [`${result.dimension} (${result.window}, since ${new Date(result.windowStartMs).toLocaleString()}):`];
  if (result.rows.length === 0) {
    lines.push('  (no attributed records in this window)');
    return lines;
  }
  for (const row of result.rows) {
    lines.push(`  ${row.key.padEnd(24)} ${formatCostAmount(row.costUsd, row.costState).padEnd(20)} ${formatTokens(row.tokens)}`);
  }
  lines.push(`  total: ${formatCostAmount(result.totalCostUsd, result.costState)} — ${result.pricedRecordCount} priced, ${result.unpricedRecordCount} unpriced record(s)`);
  return lines;
}
