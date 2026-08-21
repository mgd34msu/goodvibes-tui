/**
 * checkin-runtime.ts
 *
 * `/checkin`, the proactive check-in surface: config (enabled/cadence/
 * delivery channel/quiet hours) and its receipt trail, over the operator
 * wire (see operator-rpc.ts for why this goes over HTTP rather than the
 * in-process OperatorClient facade). Off by default; every run, scheduled
 * or manual, leaves a receipt (`checkin.receipts.list`) recording whether it
 * stayed quiet, delivered a message, or was skipped, so the config surface
 * in /config's Automation group is never the only place this feature's
 * behavior is visible.
 */
import type { CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

type CheckinConfig = OperatorMethodOutput<'checkin.config.get'>['config'];
type CheckinReceipt = OperatorMethodOutput<'checkin.receipts.list'>['receipts'][number];

export function renderConfig(config: CheckinConfig): string {
  return [
    'Check-in config:',
    `  enabled:         ${config.enabled ? 'yes' : 'no'}`,
    `  cadence (cron):  ${config.cadence || '(not set)'}`,
    `  delivery channel: ${config.deliveryChannel || '(not set)'}`,
    `  quiet hours:     ${config.quietHours || '(none)'}`,
  ].join('\n');
}

export function renderReceipt(receipt: CheckinReceipt): string {
  const parts = [`  ${new Date(receipt.ranAt).toISOString()}  [${receipt.trigger}]  ${receipt.outcome}`];
  parts.push(`    ${receipt.briefingSummary}`);
  if (receipt.decisionReason) parts.push(`    reason: ${receipt.decisionReason}`);
  if (receipt.deliveredMessage) parts.push(`    delivered: ${receipt.deliveredMessage}`);
  if (receipt.deliveryChannel) parts.push(`    channel: ${receipt.deliveryChannel}`);
  if (receipt.error) parts.push(`    error: ${receipt.error}`);
  return parts.join('\n');
}

export function registerCheckinRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'checkin',
    description: 'Proactive check-in: view config + recent receipts, or trigger one now',
    usage: '[run]',
    argsHint: '[run]',
    async handler(args, ctx) {
      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) {
        ctx.print(`[checkin] ${rpc.reason}`);
        return;
      }

      if (args[0] === 'run') {
        try {
          const result = await rpc.sdk.operator.invoke('checkin.run', {});
          const lines = [`[checkin run] outcome: ${result.outcome}`, `  ${result.summary}`];
          if (result.deliveryId) lines.push(`  delivery id: ${result.deliveryId}`);
          ctx.print(lines.join('\n'));
        } catch (error) {
          ctx.print(`[checkin run] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (args.length > 0) {
        ctx.print('Usage: /checkin [run]');
        return;
      }

      try {
        const [{ config }, { receipts }] = await Promise.all([
          rpc.sdk.operator.invoke('checkin.config.get', {}),
          rpc.sdk.operator.invoke('checkin.receipts.list', { limit: 10 }),
        ]);
        const lines = [renderConfig(config), ''];
        if (receipts.length === 0) {
          lines.push('No check-in receipts yet.');
        } else {
          lines.push('Recent receipts:');
          lines.push(...receipts.map(renderReceipt));
        }
        lines.push('', '  /checkin run: trigger one now');
        ctx.print(lines.join('\n'));
      } catch (error) {
        ctx.print(`[checkin] ${describeOperatorRpcError(error)}`);
      }
    },
  });
}
