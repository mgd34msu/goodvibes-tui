import type { CommandRegistry } from '../command-registry.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import { buildProviderAccountSnapshot } from '../../runtime/provider-accounts/registry.ts';

export function registerProviderAccountsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'accounts',
    aliases: ['account'],
    description: 'Review provider auth routes, subscription windows, and billing-path safety',
    usage: '[review|panel|show <provider>|routes <provider>|repair <provider>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        if (ctx.showPanel) ctx.showPanel('accounts');
        else {
          const panelManager = getPanelManager();
          panelManager.open('accounts');
          panelManager.show();
          ctx.renderRequest();
        }
        return;
      }
      const snapshot = await buildProviderAccountSnapshot();
      if (sub === 'routes') {
        const providerId = args[1];
        const record = snapshot.providers.find((entry) => entry.providerId === providerId);
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
        const record = snapshot.providers.find((entry) => entry.providerId === providerId);
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
          ...(record.recommendedActions.length > 0
            ? ['  next:', ...record.recommendedActions.map((action) => `    ${action}`)]
            : ['  No active repair actions suggested.']),
        ].join('\n'));
        return;
      }
      if (sub === 'show') {
        const providerId = args[1];
        const record = snapshot.providers.find((entry) => entry.providerId === providerId);
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
          ...record.recommendedActions.map((action) => `  next: ${action}`),
        ].join('\n'));
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
