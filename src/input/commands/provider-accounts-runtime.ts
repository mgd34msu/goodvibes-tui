import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type {
  ProviderAccountRecord,
  ProviderAccountSnapshot,
} from '@/runtime/index.ts';
import type { SelectionItem } from '../selection-modal.ts';
import {
  requireOperatorClient,
} from './runtime-services.ts';

type RecommendedAction = ProviderAccountRecord['recommendedActions'][number];

async function loadProviderAccountSnapshot(context: CommandContext): Promise<ProviderAccountSnapshot> {
  return await requireOperatorClient(context).providers.accountSnapshot();
}

function findProviderAccountRecord(
  snapshot: ProviderAccountSnapshot,
  providerId: string | undefined,
): ProviderAccountRecord | undefined {
  if (!providerId) return undefined;
  return snapshot.providers.find((entry) => entry.providerId === providerId);
}

/**
 * Present a record's recommended actions as executable rows. A recommended
 * action that carries a structured command becomes a press-Enter row that RUNS
 * that command through the command registry — never a line the user has to
 * retype. Actions with no command are genuinely out-of-product steps, so they
 * stay as plain (non-executing) rows. When there is no interactive selection
 * surface, each action is printed honestly instead.
 */
function presentRecommendedActions(
  ctx: CommandContext,
  providerId: string,
  actions: readonly RecommendedAction[],
): void {
  if (actions.length === 0) {
    ctx.print('No active repair actions suggested.');
    return;
  }
  if (ctx.openSelection) {
    const items: SelectionItem[] = actions.map((action, index) => {
      if (action.command) {
        const argsPart = action.command.args.length > 0 ? ` ${action.command.args.join(' ')}` : '';
        return {
          id: String(index),
          label: action.description,
          detail: `runs /${action.command.name}${argsPart}`,
          primaryAction: 'select',
        };
      }
      return {
        id: String(index),
        label: action.description,
        detail: 'manual step (nothing to run)',
        primaryAction: 'select',
      };
    });
    ctx.openSelection(
      `Repair ${providerId}`,
      items,
      { allowSearch: false, primaryVerbLabel: 'Run' },
      (result) => {
        if (!result) return;
        const action = actions[Number(result.item.id)];
        if (!action) return;
        if (action.command) {
          const args = [...action.command.args];
          void (ctx.executeCommand?.(action.command.name, args)
            ?? Promise.resolve(ctx.print(`Cannot run /${action.command.name} — command execution is unavailable here.`)));
          return;
        }
        ctx.print(action.description);
      },
    );
    return;
  }
  // No selection surface (headless/command-only): list actions honestly.
  ctx.print([
    'Recommended actions:',
    ...actions.map((action) => (
      action.command
        ? `  • ${action.description} — /${action.command.name}${action.command.args.length > 0 ? ` ${action.command.args.join(' ')}` : ''}`
        : `  • ${action.description} (manual step)`
    )),
  ].join('\n'));
}

export function registerProviderAccountsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'accounts',
    aliases: ['account'],
    description: 'Review provider auth routes, subscription windows, and billing-path safety',
    usage: '[review|panel|show <provider>|routes <provider>|repair <provider>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        ctx.openModal?.('providers-modal'); // accounts alias -> provider-health modal
        return;
      }
      const snapshot = await loadProviderAccountSnapshot(ctx);
      if (sub === 'routes') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account: ${providerId}` : 'Usage: /accounts routes <provider>');
          return;
        }
        ctx.print([
          `Provider Routes ${record.providerId}`,
          `  preferred: ${record.preferredRoute}`,
          `  active: ${record.activeRoute}`,
          `  reason: ${record.activeRouteReason}`,
          ...record.routeRecords.map((route) => `  ${route.route}  usable=${route.usable ? 'yes' : 'no'}  freshness=${route.freshness}  ${route.detail}`),
          ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue: ${issue}`)),
        ].join('\n'));
        return;
      }
      if (sub === 'repair') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account: ${providerId}` : 'Usage: /accounts repair <provider>');
          return;
        }
        ctx.print([
          `Provider Account Repair ${record.providerId}`,
          `  active route: ${record.activeRoute}`,
          `  preferred route: ${record.preferredRoute}`,
          ...(record.fallbackRisk ? [`  fallback: ${record.fallbackRisk}`] : []),
          ...(record.issues.map((issue) => `  issue: ${issue}`)),
        ].join('\n'));
        presentRecommendedActions(ctx, record.providerId, record.recommendedActions);
        return;
      }
      if (sub === 'show') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account: ${providerId}` : 'Usage: /accounts show <provider>');
          return;
        }
        ctx.print([
          `Provider Account ${record.providerId}`,
          `  preferredRoute: ${record.preferredRoute}`,
          `  activeRoute: ${record.activeRoute}`,
          `  authFreshness: ${record.authFreshness}`,
          `  configured: ${record.configured ? 'yes' : 'no'}`,
          `  oauthReady: ${record.oauthReady ? 'yes' : 'no'}`,
          `  pendingLogin: ${record.pendingLogin ? 'yes' : 'no'}`,
          `  availableRoutes: ${record.availableRoutes.join(', ')}`,
          `  modelCount: ${record.modelCount}`,
          `  routeReason: ${record.activeRouteReason}`,
          ...(record.fallbackRoute ? [`  fallbackRoute: ${record.fallbackRoute}`] : []),
          ...(record.fallbackRisk ? [`  fallbackRisk: ${record.fallbackRisk}`] : []),
          ...(record.expiresAt ? [`  expiresAt: ${new Date(record.expiresAt).toISOString()}`] : []),
          ...record.routeRecords.map((route) => `  route ${route.route}: usable=${route.usable ? 'yes' : 'no'} freshness=${route.freshness} — ${route.detail}`),
          ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue: ${issue}`)),
          ...record.usageWindows.map((entry) => `  window: ${entry.label} — ${entry.detail}`),
          ...record.issues.map((issue) => `  issue: ${issue}`),
          ...record.notes.map((note) => `  note: ${note}`),
        ].join('\n'));
        presentRecommendedActions(ctx, record.providerId, record.recommendedActions);
        return;
      }
      ctx.print([
        'Provider Account Review',
        `  providers: ${snapshot.providers.length}`,
        `  configured: ${snapshot.configuredCount}`,
        `  issues: ${snapshot.issueCount}`,
        ...snapshot.providers.map((record) => (
          `  ${record.providerId}  active=${record.activeRoute}  preferred=${record.preferredRoute}  freshness=${record.authFreshness}  models=${record.modelCount}  issues=${record.issues.length}`
        )),
      ].join('\n'));
    },
  });
}
