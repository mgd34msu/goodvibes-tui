import type { CommandRegistry } from '../command-registry.ts';
import { BUDGET_ALERT_USD_CONFIG_KEY } from '@pellux/goodvibes-sdk/platform/providers';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import {
  COST_ATTRIBUTION_OPTIONAL_DIMENSIONS,
  COST_ATTRIBUTION_PRIMARY_DIMENSIONS,
  formatCostAttributionSection,
  type CostAttributionResult,
  type CostWindow,
} from './cost-attribution-format.ts';

/**
 * /usage and /cost. `/usage` (and `/cost` or `/cost panel`) opens the Usage
 * modal. `/cost budget <usd>` sets the budget alert: it writes the
 * behavior.budgetAlertUsd setting, the one the Usage modal's b key, the Usage
 * modal's budget row and the background budget-breach notifier all read, so
 * the alert is real wherever it shows. 0 turns it off.
 */
export function registerCostRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'usage',
    description: 'Context pressure, session tokens and cost, per-turn history, per-agent costs and the budget alert',
    usage: '[turns|agents]',
    handler(args, ctx) {
      const tab = (args[0] ?? '').toLowerCase();
      if (!ctx.openUsage) {
        ctx.print('The Usage view is not available in this session.');
        return;
      }
      ctx.openUsage({ tab: tab === 'turns' || tab === 'agents' ? tab : undefined });
    },
  });

  registry.register({
    name: 'cost',
    description: 'Open Usage, set the session budget alert, or show windowed cost attribution',
    usage: '[panel|budget <usd>|attribution [24h|7d] [--json]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'panel').toLowerCase();

      if (sub === 'panel' || sub === 'open') {
        if (ctx.openUsage) ctx.openUsage();
        else ctx.print('The Usage view is not available in this session.');
        return;
      }

      if (sub === 'budget') {
        const raw = args[1];
        const usd = raw !== undefined ? Number(raw) : NaN;
        if (raw === undefined || !Number.isFinite(usd) || usd < 0) {
          ctx.print('Usage: /cost budget <usd>  (0 disables the alert)');
          return;
        }
        const config = ctx.platform.configManager;
        config.set(BUDGET_ALERT_USD_CONFIG_KEY as Parameters<typeof config.set>[0], usd as never);
        ctx.print(usd > 0
          ? `Cost budget alert set to $${usd.toFixed(2)}.`
          : 'Cost budget alert disabled.');
        ctx.renderRequest();
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
