import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireIntegrationHelpers } from './runtime-services.ts';
import { runChannelPairing } from './channel-pairing.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

type ChannelProfileBinding = OperatorMethodOutput<'channels.profiles.list'>['bindings'][number];

function renderProfileBinding(binding: ChannelProfileBinding): string {
  const scope = binding.channelId ? `${binding.surfaceKind}:${binding.channelId}` : `${binding.surfaceKind} (surface-wide default)`;
  const lines = [`  ${scope}`];
  if (binding.model) lines.push(`    model: ${binding.model}${binding.provider ? ` (${binding.provider})` : ''}`);
  if (binding.permissionMode) lines.push(`    permission mode: ${binding.permissionMode}`);
  return lines.join('\n');
}

const CHANNEL_PROFILES_SUBCOMMANDS = ['list', 'get', 'set', 'delete'] as const;

async function handleChannelProfilesSubcommand(args: string[], ctx: CommandContext): Promise<void> {
  const sub = args[0] ?? 'list';
  if (!(CHANNEL_PROFILES_SUBCOMMANDS as readonly string[]).includes(sub)) {
    ctx.print(
      'Usage: /channel profiles <subcommand>\n'
      + '  list                                    — every per-channel profile binding\n'
      + '  get <surfaceKind> [channelId]           — one binding\n'
      + '  set <surfaceKind> [channelId] [--model x] [--provider x] [--permission-mode x]  — bind (upsert)\n'
      + '  delete <surfaceKind> [channelId]        — remove a binding'
    );
    return;
  }

  if (sub === 'list') {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const { bindings } = await rpc.sdk.operator.invoke('channels.profiles.list', {});
      if (bindings.length === 0) {
        ctx.print('[channel profiles] no profile bindings configured.');
        return;
      }
      ctx.print(['Channel profile bindings:', ...bindings.map(renderProfileBinding)].join('\n'));
    } catch (error) {
      ctx.print(`[channel profiles list] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'get') {
    const surfaceKind = args[1];
    const channelId = args[2];
    if (!surfaceKind) {
      ctx.print('Usage: /channel profiles get <surfaceKind> [channelId]');
      return;
    }
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const { binding } = await rpc.sdk.operator.invoke('channels.profiles.get', { surfaceKind, ...(channelId ? { channelId } : {}) });
      ctx.print(renderProfileBinding(binding));
    } catch (error) {
      ctx.print(`[channel profiles get] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'set') {
    const rest = args.slice(1);
    const flagStart = rest.findIndex((token) => token.startsWith('--'));
    const positional = flagStart === -1 ? rest : rest.slice(0, flagStart);
    const flagTokens = flagStart === -1 ? [] : rest.slice(flagStart);
    const surfaceKind = positional[0];
    const channelId = positional[1];
    if (!surfaceKind) {
      ctx.print('Usage: /channel profiles set <surfaceKind> [channelId] [--model x] [--provider x] [--permission-mode plan|normal|accept-edits|auto]');
      return;
    }
    const flags = new Map<string, string>();
    for (let i = 0; i < flagTokens.length; i++) {
      const token = flagTokens[i]!;
      if (!token.startsWith('--')) continue;
      const name = token.slice(2);
      const value = flagTokens[i + 1];
      if (value !== undefined) {
        flags.set(name, value);
        i++;
      }
    }
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const { binding } = await rpc.sdk.operator.invoke('channels.profiles.set', {
        surfaceKind,
        ...(channelId ? { channelId } : {}),
        ...(flags.has('model') ? { model: flags.get('model')! } : {}),
        ...(flags.has('provider') ? { provider: flags.get('provider')! } : {}),
        ...(flags.has('permission-mode') ? { permissionMode: flags.get('permission-mode') as 'plan' | 'normal' | 'accept-edits' | 'auto' } : {}),
      });
      ctx.print(`[channel profiles set] bound ${binding.id}\n${renderProfileBinding(binding)}`);
    } catch (error) {
      ctx.print(`[channel profiles set] ${describeOperatorRpcError(error)}`);
    }
    return;
  }

  if (sub === 'delete') {
    const surfaceKind = args[1];
    const channelId = args[2];
    if (!surfaceKind) {
      ctx.print('Usage: /channel profiles delete <surfaceKind> [channelId]');
      return;
    }
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) {
      ctx.print(`[channel profiles] ${rpc.reason}`);
      return;
    }
    try {
      const result = await rpc.sdk.operator.invoke('channels.profiles.delete', { surfaceKind, ...(channelId ? { channelId } : {}) });
      ctx.print(result.deleted
        ? `[channel profiles delete] removed binding for ${surfaceKind}${channelId ? `:${channelId}` : ''}.`
        : `[channel profiles delete] no binding found for ${surfaceKind}${channelId ? `:${channelId}` : ''}.`);
    } catch (error) {
      ctx.print(`[channel profiles delete] ${describeOperatorRpcError(error)}`);
    }
    return;
  }
}

export function registerChannelRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'channel',
    aliases: ['channels'],
    description: 'Pair channels and inspect routes, delivery strategies, ingress policies, and per-channel profile bindings',
    usage: '[pair [surface]|status|routes|delivery|policy|profiles [list|get|set|delete]] [--json]',
    argsHint: 'pair | status | routes | delivery | policy | profiles',
    async handler(args, ctx) {
      const sub = args[0];
      const asJson = args.includes('--json');

      if (!sub || sub === 'open' || sub === 'panel') {
        if (ctx.showPanel) ctx.showPanel('routes');
        return;
      }

      if (sub === 'pair') {
        runChannelPairing(args.slice(1), ctx);
        return;
      }

      if (sub === 'profiles') {
        await handleChannelProfilesSubcommand(args.slice(1), ctx);
        return;
      }

      const helpers = requireIntegrationHelpers(ctx);

      if (sub === 'status') {
        const review = helpers.buildReview();
        if (asJson) {
          ctx.print(JSON.stringify(review, null, 2));
          return;
        }
        const lines: string[] = [
          'Channel Status',
          `  routes:            ${review.routes.length}`,
          `  api families:      ${review.apiFamilies.join(', ') || '(none)'}`,
          `  sessions:          ${review.sessions}`,
          `  tasks:             ${review.tasks}`,
          `  pending approvals: ${review.pendingApprovals}`,
          `  remote contracts:  ${review.remoteContracts}`,
          '',
          `Active route families: ${review.routes.join(', ') || '(none)'}`,
          '',
          'Use /channel routes for delivery binding details.',
          'Use /channel delivery for outbound delivery snapshot.',
          'Use /channel policy for ingress policy snapshot.',
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'routes') {
        const snapshot = helpers.getRouteSnapshot();
        if (asJson) {
          ctx.print(JSON.stringify(snapshot, null, 2));
          return;
        }
        const entries = Object.entries(snapshot);
        if (entries.length === 0) {
          ctx.print('No route bindings active.\n\nRoutes become active when channel surfaces (slack, discord, ntfy, webhook, etc.) are configured and the daemon is running.');
          return;
        }
        const lines: string[] = ['Channel Routes'];
        for (const [key, value] of entries) {
          lines.push(`  ${String(key).padEnd(28)} ${JSON.stringify(value)}`);
        }
        lines.push('');
        lines.push('Route bindings reflect active daemon surface registrations.');
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'delivery') {
        const snapshot = helpers.getDeliverySnapshot();
        if (asJson) {
          ctx.print(JSON.stringify(snapshot, null, 2));
          return;
        }
        const entries = Object.entries(snapshot);
        if (entries.length === 0) {
          ctx.print('No delivery snapshot available.\n\nDelivery state is populated when the daemon handles outbound channel messages.');
          return;
        }
        const lines: string[] = ['Channel Delivery Snapshot'];
        for (const [key, value] of entries) {
          lines.push(`  ${String(key).padEnd(28)} ${JSON.stringify(value)}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'policy') {
        const configManager = ctx.platform.configManager;
        // Channel policy is persisted by ChannelPolicyManager in
        // .goodvibes/tui/channels/policies.json — surface via configManager
        // category (runtime-accessible without a daemon round-trip).
        const surfaces = [
          'slack', 'discord', 'ntfy', 'webhook', 'homeassistant',
          'telegram', 'google-chat', 'signal', 'whatsapp',
          'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix',
        ];
        const lines: string[] = ['Channel Ingress Policies'];
        let found = false;
        for (const surface of surfaces) {
          const key = `surfaces.${surface}.enabled` as Parameters<typeof configManager.get>[0];
          const enabled = configManager.get(key);
          if (enabled !== undefined && enabled !== null) {
            found = true;
            lines.push(`  ${surface.padEnd(20)} enabled=${String(enabled)}`);
          }
        }
        if (!found) {
          lines.push('  No channel surfaces configured.');
          lines.push('');
          lines.push('  Configure surfaces via /onboarding or Settings > Surfaces.');
          lines.push('  Fine-grained ingress policies (allowedCommands, requireMention, groupPolicies)');
          lines.push('  are managed by ChannelPolicyManager in .goodvibes/tui/channels/policies.json.');
        } else {
          lines.push('');
          lines.push('  Fine-grained ingress policies (allowedCommands, requireMention, groupPolicies)');
          lines.push('  are managed by ChannelPolicyManager in .goodvibes/tui/channels/policies.json.');
        }
        if (asJson) {
          ctx.print(JSON.stringify({ surfaces: Object.fromEntries(surfaces.map((s) => [s, configManager.get(`surfaces.${s}.enabled` as Parameters<typeof configManager.get>[0])])) }, null, 2));
          return;
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print(
        'Usage: /channel <subcommand>\n'
        + '  (no args)  — open the Routes panel\n'
        + '  pair [surface] — guided channel pairing: list adapters, enter declared credentials, verify\n'
        + '  status     — channel overview: routes, sessions, tasks, pending approvals\n'
        + '  routes     — active route binding snapshot\n'
        + '  delivery   — outbound delivery snapshot\n'
        + '  policy     — configured channel surfaces and ingress policy location\n'
        + '  profiles [list|get|set|delete]  — per-channel model/permission profile bindings\n'
        + '\n'
        + 'Options:\n'
        + '  --json  Output raw JSON for scripting'
      );
    },
  });
}
