import type { ProviderAuthRouteDescriptor } from '@pellux/goodvibes-sdk/platform/providers';

function routeUsable(route: ProviderAuthRouteDescriptor): boolean {
  return route.usable ?? route.configured;
}

export function summarizeProviderAuthRoutes(routes: readonly ProviderAuthRouteDescriptor[] | undefined): string {
  if (!routes?.length) return 'n/a';
  const configured = routes.filter((route) => route.configured).length;
  const usable = routes.filter(routeUsable).length;
  return `${configured}/${routes.length} configured, ${usable}/${routes.length} usable`;
}

export function formatProviderAuthRoute(route: ProviderAuthRouteDescriptor): string {
  const status = [
    route.configured ? 'configured' : 'not configured',
    routeUsable(route) ? 'usable' : 'not usable',
    route.freshness,
  ].filter((part): part is string => Boolean(part));
  const detail = route.detail?.trim();
  return `${route.label} [${route.route}; ${status.join(', ')}]${detail ? ` - ${detail}` : ''}`;
}
