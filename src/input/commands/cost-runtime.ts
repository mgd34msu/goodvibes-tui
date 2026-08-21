import type { CommandRegistry } from '../command-registry.ts';
import { CostTrackerPanel } from '../../panels/cost-tracker-panel.ts';
import { openCommandPanel, requirePanelManager } from './runtime-services.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import {
  COST_ATTRIBUTION_OPTIONAL_DIMENSIONS,
  COST_ATTRIBUTION_PRIMARY_DIMENSIONS,
  formatCostAttributionSection,
  type CostAttributionResult,
  type CostWindow,
} from './cost-attribution-format.ts';

/**
 * /cost budget <usd>, makes the CostTrackerPanel's budget alert real.
 * Opens the cost panel (creating it via the registered factory if not already
 * open) and sets its budget threshold directly, so the meter+alert already
 * built into CostTrackerPanel.render() (:266-290) actually fires. 0 disables
 * the alert. Mirrors the /auth local rotate-password → panel-instance-call
 * pattern (local-auth-runtime.ts) rather than only printing a signpost.
 */
export function registerCostRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cost',
    description: 'Inspect session/agent cost tracking, windowed cost attribution, and the budget alert threshold',
    usage: '[panel|budget <usd>|attribution [24h|7d] [--json]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'panel').toLowerCase();

      if (sub === 'panel' || sub === 'open') {
        openCommandPanel(ctx, 'cost');
        return;
      }

      if (sub === 'budget') {
        const raw = args[1];
        const usd = raw !== undefined ? Number(raw) : NaN;
        if (raw === undefined || !Number.isFinite(usd) || usd < 0) {
          ctx.print('Usage: /cost budget <usd>  (0 disables the alert)');
          return;
        }
        const panelManager = requirePanelManager(ctx);
        const panel = panelManager.open('cost');
        if (panel instanceof CostTrackerPanel) {
          panel.setBudgetThreshold(usd);
          ctx.print(usd > 0
            ? `Cost budget alert set to $${usd.toFixed(2)}.`
            : 'Cost budget alert disabled.');
        } else {
          ctx.print('Cost tracking is not available in this session.');
        }
        return;
      }

      if (sub === 'attribution' || sub === 'attr') {
        const window: CostWindow = args.includes('7d') ? '7d' : '24h';
        const asJson = args.includes('--json');
        const rpc = getOperatorRpc(ctx);
        if (!rpc.available) {
          ctx.print(`[cost attribution] ${rpc.reason}`);
          return;
        }
        const dimensions = [...COST_ATTRIBUTION_PRIMARY_DIMENSIONS, ...COST_ATTRIBUTION_OPTIONAL_DIMENSIONS];
        const results: CostAttributionResult[] = [];
        try {
          for (const dimension of dimensions) {
            results.push(await rpc.sdk.operator.invoke('cost.attribution.get', { window, dimension }));
          }
        } catch (error) {
          ctx.print(`[cost attribution] round-trip request failed: ${describeOperatorRpcError(error)}`);
          return;
        }
        if (asJson) {
          ctx.print(JSON.stringify(results, null, 2));
          return;
        }
        const lines: string[] = [`Cost Attribution: ${window}`];
        for (const result of results) {
          const isOptional = (COST_ATTRIBUTION_OPTIONAL_DIMENSIONS as readonly string[]).includes(result.dimension);
          const section = formatCostAttributionSection(result, isOptional);
          if (section) lines.push('', ...section);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print('Usage: /cost [panel|budget <usd>|attribution [24h|7d] [--json]]');
    },
  });
}
