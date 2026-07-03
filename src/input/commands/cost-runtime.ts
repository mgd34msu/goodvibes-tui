import type { CommandRegistry } from '../command-registry.ts';
import { CostTrackerPanel } from '../../panels/cost-tracker-panel.ts';
import { openCommandPanel, requirePanelManager } from './runtime-services.ts';

/**
 * /cost budget <usd> — makes the CostTrackerPanel's budget alert real (WO-139).
 * Opens the cost panel (creating it via the registered factory if not already
 * open) and sets its budget threshold directly, so the meter+alert already
 * built into CostTrackerPanel.render() (:266-290) actually fires. 0 disables
 * the alert. Mirrors the /auth local rotate-password → panel-instance-call
 * pattern (local-auth-runtime.ts) rather than only printing a signpost.
 */
export function registerCostRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cost',
    description: 'Inspect session/agent cost tracking and configure the budget alert threshold',
    usage: '[panel|budget <usd>]',
    handler(args, ctx) {
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

      ctx.print('Usage: /cost [panel|budget <usd>]');
    },
  });
}
