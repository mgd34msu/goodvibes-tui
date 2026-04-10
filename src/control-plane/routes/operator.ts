import type { DaemonApiRouteHandlers } from './context.ts';

export async function dispatchOperatorRoutes(
  req: Request,
  handlers: Pick<
    DaemonApiRouteHandlers,
    | 'getStatus'
    | 'getControlPlaneSnapshot'
    | 'getControlPlaneWeb'
    | 'getControlPlaneRecentEvents'
    | 'getControlPlaneMessages'
    | 'getControlPlaneClients'
    | 'createControlPlaneEventStream'
    | 'getRoutesSnapshot'
    | 'getSurfaces'
    | 'getChannelAccounts'
    | 'getChannelSurfaceAccounts'
    | 'getChannelAccount'
    | 'postChannelAccountAction'
    | 'getChannelCapabilities'
    | 'getChannelSurfaceCapabilities'
    | 'getChannelTools'
    | 'getChannelSurfaceTools'
    | 'getChannelAgentTools'
    | 'getChannelSurfaceAgentTools'
    | 'postChannelTool'
    | 'getChannelActions'
    | 'getChannelSurfaceActions'
    | 'postChannelAction'
    | 'postChannelResolveTarget'
    | 'postChannelAuthorize'
    | 'getChannelPolicies'
    | 'postChannelPolicy'
    | 'getChannelPolicyAudit'
    | 'getChannelStatus'
    | 'getChannelDirectory'
    | 'getWatchers'
    | 'postWatcher'
    | 'patchWatcher'
    | 'watcherAction'
    | 'deleteWatcher'
    | 'getServiceStatus'
    | 'installService'
    | 'startService'
    | 'stopService'
    | 'restartService'
    | 'uninstallService'
    | 'getRouteBindings'
    | 'postRouteBinding'
    | 'patchRouteBinding'
    | 'deleteRouteBinding'
    | 'getApprovals'
    | 'approvalAction'
    | 'getRemote'
    | 'getHealth'
    | 'getAccounts'
    | 'getSettings'
    | 'getContinuity'
    | 'getWorktrees'
    | 'getIntelligence'
    | 'getLocalAuth'
    | 'postLocalAuthUser'
    | 'deleteLocalAuthUser'
    | 'postLocalAuthPassword'
    | 'deleteLocalAuthSession'
    | 'deleteBootstrapFile'
    | 'getPanels'
    | 'postPanelOpen'
    | 'getEvents'
    | 'getConfig'
    | 'postConfig'
    | 'getReview'
    | 'getIntegrationSession'
    | 'getIntegrationTasks'
    | 'getIntegrationAutomation'
    | 'getIntegrationSessions'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/status' && method === 'GET') return handlers.getStatus();
  if (pathname === '/api/control-plane' && method === 'GET') return handlers.getControlPlaneSnapshot();
  if (pathname === '/api/control-plane/web' && method === 'GET') return handlers.getControlPlaneWeb();
  if (pathname === '/api/control-plane/recent-events' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return handlers.getControlPlaneRecentEvents(limit);
  }
  if (pathname === '/api/control-plane/messages' && method === 'GET') return handlers.getControlPlaneMessages();
  if (pathname === '/api/control-plane/clients' && method === 'GET') return handlers.getControlPlaneClients();
  if (pathname === '/api/control-plane/events' && method === 'GET') return handlers.createControlPlaneEventStream(req);
  if (pathname === '/api/routes' && method === 'GET') return handlers.getRoutesSnapshot();
  if (pathname === '/api/surfaces' && method === 'GET') return handlers.getSurfaces();
  if (pathname === '/api/channels/accounts' && method === 'GET') return handlers.getChannelAccounts();
  if (pathname === '/api/channels/capabilities' && method === 'GET') return handlers.getChannelCapabilities();
  if (pathname === '/api/channels/tools' && method === 'GET') return handlers.getChannelTools();
  if (pathname === '/api/channels/agent-tools' && method === 'GET') return handlers.getChannelAgentTools();
  if (pathname === '/api/channels/actions' && method === 'GET') return handlers.getChannelActions();
  const channelAccountDefaultActionMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/actions\/([^/]+)$/);
  if (channelAccountDefaultActionMatch && method === 'POST') {
    return handlers.postChannelAccountAction(
      decodeURIComponent(channelAccountDefaultActionMatch[1]),
      null,
      decodeURIComponent(channelAccountDefaultActionMatch[2]),
      req,
    );
  }
  const channelAccountActionMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/([^/]+)\/actions\/([^/]+)$/);
  if (channelAccountActionMatch && method === 'POST') {
    return handlers.postChannelAccountAction(
      decodeURIComponent(channelAccountActionMatch[1]),
      decodeURIComponent(channelAccountActionMatch[2]),
      decodeURIComponent(channelAccountActionMatch[3]),
      req,
    );
  }
  const channelResolveTargetMatch = pathname.match(/^\/api\/channels\/targets\/([^/]+)\/resolve$/);
  if (channelResolveTargetMatch && method === 'POST') {
    return handlers.postChannelResolveTarget(decodeURIComponent(channelResolveTargetMatch[1]), req);
  }
  const channelAuthorizeMatch = pathname.match(/^\/api\/channels\/authorize\/([^/]+)$/);
  if (channelAuthorizeMatch && method === 'POST') {
    return handlers.postChannelAuthorize(decodeURIComponent(channelAuthorizeMatch[1]), req);
  }
  const channelAccountMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)\/([^/]+)$/);
  if (channelAccountMatch && method === 'GET') {
    return handlers.getChannelAccount(decodeURIComponent(channelAccountMatch[1]), decodeURIComponent(channelAccountMatch[2]));
  }
  const channelActionPostMatch = pathname.match(/^\/api\/channels\/actions\/([^/]+)\/([^/]+)$/);
  if (channelActionPostMatch && method === 'POST') {
    return handlers.postChannelAction(decodeURIComponent(channelActionPostMatch[1]), decodeURIComponent(channelActionPostMatch[2]), req);
  }
  const channelSurfaceAccountsMatch = pathname.match(/^\/api\/channels\/accounts\/([^/]+)$/);
  if (channelSurfaceAccountsMatch && method === 'GET') {
    return handlers.getChannelSurfaceAccounts(decodeURIComponent(channelSurfaceAccountsMatch[1]));
  }
  const channelSurfaceCapabilitiesMatch = pathname.match(/^\/api\/channels\/capabilities\/([^/]+)$/);
  if (channelSurfaceCapabilitiesMatch && method === 'GET') {
    return handlers.getChannelSurfaceCapabilities(decodeURIComponent(channelSurfaceCapabilitiesMatch[1]));
  }
  const channelSurfaceToolsMatch = pathname.match(/^\/api\/channels\/tools\/([^/]+)$/);
  if (channelSurfaceToolsMatch && method === 'GET') {
    return handlers.getChannelSurfaceTools(decodeURIComponent(channelSurfaceToolsMatch[1]));
  }
  const channelSurfaceAgentToolsMatch = pathname.match(/^\/api\/channels\/agent-tools\/([^/]+)$/);
  if (channelSurfaceAgentToolsMatch && method === 'GET') {
    return handlers.getChannelSurfaceAgentTools(decodeURIComponent(channelSurfaceAgentToolsMatch[1]));
  }
  const channelToolPostMatch = pathname.match(/^\/api\/channels\/tools\/([^/]+)\/([^/]+)$/);
  if (channelToolPostMatch && method === 'POST') {
    return handlers.postChannelTool(decodeURIComponent(channelToolPostMatch[1]), decodeURIComponent(channelToolPostMatch[2]), req);
  }
  const channelSurfaceActionsMatch = pathname.match(/^\/api\/channels\/actions\/([^/]+)$/);
  if (channelSurfaceActionsMatch && method === 'GET') {
    return handlers.getChannelSurfaceActions(decodeURIComponent(channelSurfaceActionsMatch[1]));
  }
  if (pathname === '/api/channels/policies' && method === 'GET') return handlers.getChannelPolicies();
  const channelPolicyMatch = pathname.match(/^\/api\/channels\/policies\/([^/]+)$/);
  if (channelPolicyMatch && method === 'POST') return handlers.postChannelPolicy(channelPolicyMatch[1], req);
  if (pathname === '/api/channels/policies/audit' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return handlers.getChannelPolicyAudit(limit);
  }
  if (pathname === '/api/channels/status' && method === 'GET') return handlers.getChannelStatus();
  const channelDirectoryMatch = pathname.match(/^\/api\/channels\/directory\/([^/]+)$/);
  if (channelDirectoryMatch && method === 'GET') return handlers.getChannelDirectory(channelDirectoryMatch[1], url);
  if (pathname === '/api/watchers' && method === 'GET') return handlers.getWatchers();
  if (pathname === '/api/watchers' && method === 'POST') return handlers.postWatcher(req);
  const watcherUpdateMatch = pathname.match(/^\/api\/watchers\/([^/]+)$/);
  if (watcherUpdateMatch && method === 'PATCH') return handlers.patchWatcher(watcherUpdateMatch[1], req);
  if (watcherUpdateMatch && method === 'DELETE') return handlers.deleteWatcher(watcherUpdateMatch[1]);
  const watcherActionMatch = pathname.match(/^\/api\/watchers\/([^/]+)\/(start|stop|run)$/);
  if (watcherActionMatch && method === 'POST') return handlers.watcherAction(watcherActionMatch[1], watcherActionMatch[2] as 'start' | 'stop' | 'run');

  if (pathname === '/api/service/status' && method === 'GET') return handlers.getServiceStatus();
  if (pathname === '/api/service/install' && method === 'POST') return handlers.installService();
  if (pathname === '/api/service/start' && method === 'POST') return handlers.startService();
  if (pathname === '/api/service/stop' && method === 'POST') return handlers.stopService();
  if (pathname === '/api/service/restart' && method === 'POST') return handlers.restartService();
  if (pathname === '/api/service/uninstall' && method === 'POST') return handlers.uninstallService();

  if (pathname === '/api/routes/bindings' && method === 'GET') return handlers.getRouteBindings();
  if (pathname === '/api/routes/bindings' && method === 'POST') return handlers.postRouteBinding(req);
  const routeBindingMatch = pathname.match(/^\/api\/routes\/bindings\/([^/]+)$/);
  if (routeBindingMatch && method === 'PATCH') return handlers.patchRouteBinding(routeBindingMatch[1], req);
  if (routeBindingMatch && method === 'DELETE') return handlers.deleteRouteBinding(routeBindingMatch[1]);

  if (pathname === '/api/approvals' && method === 'GET') return handlers.getApprovals();
  const approvalActionMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(claim|approve|deny|cancel)$/);
  if (approvalActionMatch && method === 'POST') {
    return handlers.approvalAction(approvalActionMatch[1], approvalActionMatch[2] as 'claim' | 'approve' | 'deny' | 'cancel', req);
  }

  if (pathname === '/api/remote' && method === 'GET') return handlers.getRemote();
  if (pathname === '/api/health' && method === 'GET') return handlers.getHealth();
  if (pathname === '/api/accounts' && method === 'GET') return handlers.getAccounts();
  if (pathname === '/api/settings' && method === 'GET') return handlers.getSettings();
  if (pathname === '/api/continuity' && method === 'GET') return handlers.getContinuity();
  if (pathname === '/api/worktrees' && method === 'GET') return handlers.getWorktrees();
  if (pathname === '/api/intelligence' && method === 'GET') return handlers.getIntelligence();

  if (pathname === '/api/local-auth' && method === 'GET') return handlers.getLocalAuth();
  if (pathname === '/api/local-auth/users' && method === 'POST') return handlers.postLocalAuthUser(req);
  const userMatch = pathname.match(/^\/api\/local-auth\/users\/([^/]+)$/);
  if (userMatch && method === 'DELETE') return handlers.deleteLocalAuthUser(decodeURIComponent(userMatch[1]));
  const passwordMatch = pathname.match(/^\/api\/local-auth\/users\/([^/]+)\/password$/);
  if (passwordMatch && method === 'POST') return handlers.postLocalAuthPassword(decodeURIComponent(passwordMatch[1]), req);
  const sessionMatch = pathname.match(/^\/api\/local-auth\/sessions\/([^/]+)$/);
  if (sessionMatch && method === 'DELETE') return handlers.deleteLocalAuthSession(decodeURIComponent(sessionMatch[1]));
  if (pathname === '/api/local-auth/bootstrap-file' && method === 'DELETE') return handlers.deleteBootstrapFile();

  if (pathname === '/api/panels' && method === 'GET') return handlers.getPanels();
  if (pathname === '/api/panels/open' && method === 'POST') return handlers.postPanelOpen(req);
  if (pathname === '/api/events' && method === 'GET') return handlers.getEvents(req);
  if (pathname === '/config' && method === 'GET') return handlers.getConfig();
  if (pathname === '/config' && method === 'POST') return handlers.postConfig(req);

  return null;
}
