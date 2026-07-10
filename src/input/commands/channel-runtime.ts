import type { CommandRegistry } from '../command-registry.ts';
import { requireIntegrationHelpers } from './runtime-services.ts';
import { runChannelPairing } from './channel-pairing.ts';

export function registerChannelRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'channel',
    aliases: ['channels'],
    description: 'Pair channels and inspect routes, delivery strategies, and ingress policies',
    usage: '[pair [surface]|status|routes|delivery|policy] [--json]',
    argsHint: 'pair | status | routes | delivery | policy',
    handler(args, ctx) {
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
        + '\n'
        + 'Options:\n'
        + '  --json  Output raw JSON for scripting'
      );
    },
  });
}
