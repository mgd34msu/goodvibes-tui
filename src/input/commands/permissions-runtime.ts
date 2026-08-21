import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { SelectionItem, SelectionAction } from '../selection-modal.ts';
import { buildPermissionProvenance, renderPermissionProvenance } from './permissions-provenance.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** One remembered-rule row: what it does, and how/when it was remembered. */
function describeRuleRow(record: {
  rule: { id: string; description?: string | undefined; effect: 'allow' | 'deny' };
  tier: string;
  tool: string;
  createdAt: number;
}): { label: string; detail: string } {
  const what = record.rule.description ?? record.rule.id;
  return {
    label: `${record.tool}: ${what}`,
    detail: `${record.rule.effect} · remembered ${record.tier} · ${new Date(record.createdAt).toLocaleString()}`,
  };
}

function showRememberedRules(ctx: CommandContext): void {
  const store = ctx.clients?.userPermissionRuleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  const records = store.list();
  if (records.length === 0) {
    ctx.print('No remembered permission rules. Approving an ask with a remember tier stores one here.');
    return;
  }
  if (ctx.openSelection) {
    const revoke = new Map<string, SelectionAction>([['d', 'delete']]);
    const items: SelectionItem[] = records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return { id: record.rule.id, label, detail, actions: '[d] revoke' };
    });
    ctx.openSelection('Remembered permission rules', items, { allowSearch: true, customActions: revoke }, (result) => {
      if (!result || result.action !== 'delete') return;
      void (async () => {
        try {
          const removed = await store.delete(result.item.id);
          ctx.print(removed ? `Revoked remembered rule: ${result.item.label}` : `Rule already gone: ${result.item.label}`);
        } catch (error) {
          ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
        }
      })();
    });
    return;
  }
  // No selection surface: list them honestly with the revoke command to run.
  ctx.print([
    'Remembered permission rules:',
    ...records.map((record) => {
      const { label, detail } = describeRuleRow(record);
      return `  ${record.rule.id}  ${label}  (${detail})`;
    }),
    '',
    'Revoke one with: /permissions revoke <rule-id>',
  ].join('\n'));
}

async function revokeRememberedRule(ctx: CommandContext, ruleId: string): Promise<void> {
  const store = ctx.clients?.userPermissionRuleStore;
  if (!store) {
    ctx.print('Remembered permission rules are not available on this surface.');
    return;
  }
  if (!ruleId) {
    ctx.print('Usage: /permissions revoke <rule-id>  (see /permissions rules for ids)');
    return;
  }
  try {
    const removed = await store.delete(ruleId);
    ctx.print(removed ? `Revoked remembered rule: ${ruleId}` : `No remembered rule with id: ${ruleId}`);
  } catch (error) {
    ctx.print(`Could not revoke the rule: ${summarizeError(error)}`);
  }
}

/**
 * `/permissions`, the permission settings surface. With no arguments it prints
 * every permission-relevant setting in effect and where each value came from
 * (provenance; read-only). `rules` lists the durable remembered approvals with a
 * press-Enter revoke; `revoke <id>` removes one by id. Revokes hit the same
 * in-process rule store the evaluator reads, so they take effect live.
 */
export function registerPermissionsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'permissions',
    aliases: ['perms'],
    description: 'Show permission settings and provenance, and list or revoke remembered approval rules',
    usage: '[rules | revoke <rule-id>]',
    argsHint: '[rules|revoke]',
    async handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'rules' || sub === 'rule') {
        showRememberedRules(ctx);
        return;
      }
      if (sub === 'revoke' || sub === 'forget') {
        await revokeRememberedRule(ctx, args[1] ?? '');
        return;
      }
      const provenance = buildPermissionProvenance(ctx.platform.configManager);
      ctx.print(renderPermissionProvenance(provenance));
      const ruleCount = ctx.clients?.userPermissionRuleStore?.list().length ?? 0;
      ctx.print(ruleCount > 0
        ? `\n${ruleCount} remembered approval rule${ruleCount === 1 ? '' : 's'} in effect. Use /permissions rules to review or revoke them.`
        : '\nNo remembered approval rules. Use /permissions rules once you have some.');
    },
  });
}
