import type { IntegrationHelperService } from '../../runtime/integration/helpers.ts';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot, listProviderRuntimeSnapshots } from '../../providers/runtime-snapshot.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { DaemonRouteContext } from '../types.ts';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../../state/index.ts';

type IntegrationRouteContext = Pick<
  DaemonRouteContext,
  | 'channelPlugins'
  | 'configManager'
  | 'integrationHelpers'
  | 'memoryEmbeddingRegistry'
  | 'memoryRegistry'
  | 'parseJsonBody'
  | 'providerRegistry'
  | 'requireAdmin'
  | 'userAuth'
>;

export function createDaemonIntegrationRouteHandlers(
  context: IntegrationRouteContext,
  request: Request,
): Pick<
  DaemonApiRouteHandlers,
  | 'getReview'
  | 'getIntegrationSession'
  | 'getIntegrationTasks'
  | 'getIntegrationAutomation'
  | 'getIntegrationSessions'
  | 'getDeliveries'
  | 'getDelivery'
  | 'getRoutesSnapshot'
  | 'getRemote'
  | 'getHealth'
  | 'getAccounts'
  | 'getProviders'
  | 'getProvider'
  | 'getProviderUsage'
  | 'getSettings'
  | 'getContinuity'
  | 'getWorktrees'
  | 'getIntelligence'
  | 'getMemoryDoctor'
  | 'getMemoryVectorStats'
  | 'postMemoryVectorRebuild'
  | 'postMemoryEmbeddingDefault'
  | 'getLocalAuth'
  | 'postLocalAuthUser'
  | 'deleteLocalAuthUser'
  | 'postLocalAuthPassword'
  | 'deleteLocalAuthSession'
  | 'deleteBootstrapFile'
  | 'getPanels'
  | 'postPanelOpen'
  | 'getEvents'
> {
  return {
    getReview: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.buildReview())),
    getIntegrationSession: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSessionSnapshot())),
    getIntegrationTasks: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getTaskSnapshot())),
    getIntegrationAutomation: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getAutomationSnapshot())),
    getIntegrationSessions: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSessionBrokerSnapshot())),
    getDeliveries: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getDeliverySnapshot())),
    getDelivery: (deliveryId) => {
      const runtimeStore = context.integrationHelpers?.getRuntimeStore() ?? null;
      const delivery = runtimeStore?.getState().deliveries.deliveryAttempts.get(deliveryId);
      if (!delivery) {
        return Response.json({ error: 'Unknown delivery' }, { status: 404 });
      }
      return Response.json({ delivery });
    },
    getRoutesSnapshot: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRouteSnapshot())),
    getRemote: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getRemoteSnapshot())),
    getHealth: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getHealthSnapshot())),
    getAccounts: async () => {
      if (!context.integrationHelpers) {
        return Response.json({ error: 'Integration helper service unavailable' }, { status: 503 });
      }
      const [snapshot, channelAccounts] = await Promise.all([
        context.integrationHelpers.getAccountsSnapshot(),
        context.channelPlugins.listAccounts(),
      ]);
      return Response.json({
        ...snapshot,
        channelCount: channelAccounts.length,
        channels: channelAccounts,
      });
    },
    getProviders: async () => Response.json({ providers: await listProviderRuntimeSnapshots(context.providerRegistry) }),
    getProvider: async (providerId) => {
      const provider = await getProviderRuntimeSnapshot(context.providerRegistry, providerId);
      return provider
        ? Response.json(provider)
        : Response.json({ error: 'Unknown provider' }, { status: 404 });
    },
    getProviderUsage: async (providerId) => {
      const usage = await getProviderUsageSnapshot(context.providerRegistry, providerId);
      return usage
        ? Response.json(usage)
        : Response.json({ error: 'Unknown provider' }, { status: 404 });
    },
    getSettings: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getSettingsSnapshot())),
    getContinuity: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getContinuitySnapshot())),
    getWorktrees: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getWorktreeSnapshot())),
    getIntelligence: () => withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getIntelligenceSnapshot())),
    getMemoryDoctor: async () => Response.json(await context.memoryRegistry.doctor()),
    getMemoryVectorStats: () => Response.json({ vector: context.memoryRegistry.vectorStats() }),
    postMemoryVectorRebuild: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      return Response.json({ vector: await context.memoryRegistry.rebuildVectorsAsync() });
    },
    postMemoryEmbeddingDefault: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const providerId = typeof body.providerId === 'string' ? body.providerId : '';
      if (!providerId) return Response.json({ error: 'Missing providerId' }, { status: 400 });
      try {
        context.memoryEmbeddingRegistry.setDefaultProvider(providerId);
        return Response.json(await context.memoryRegistry.doctor());
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    },
    getLocalAuth: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return withHelpers(context.integrationHelpers, (helpers) => Response.json(helpers.getLocalAuthSnapshot()));
    },
    postLocalAuthUser: async (req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const roles = Array.isArray(body.roles) ? body.roles.filter((value): value is string => typeof value === 'string') : ['admin'];
      try {
        return Response.json({ user: context.userAuth.addUser(username, password, roles) }, { status: 201 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    },
    deleteLocalAuthUser: (username) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      try {
        const removed = context.userAuth.deleteUser(username);
        return removed
          ? Response.json({ deleted: true })
          : Response.json({ error: 'Unknown user' }, { status: 404 });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    },
    postLocalAuthPassword: async (username, req) => {
      const admin = context.requireAdmin(req);
      if (admin) return admin;
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const password = typeof body.password === 'string' ? body.password : '';
      try {
        context.userAuth.rotatePassword(username, password);
        return Response.json({ rotated: true });
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }
    },
    deleteLocalAuthSession: (sessionId) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return context.userAuth.revokeSession(sessionId)
        ? Response.json({ revoked: true })
        : Response.json({ error: 'Unknown session' }, { status: 404 });
    },
    deleteBootstrapFile: () => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json({ removed: context.userAuth.clearBootstrapCredentialFile() });
    },
    getPanels: () => withHelpers(context.integrationHelpers, (helpers) => Response.json({ panels: helpers.listPanels() })),
    postPanelOpen: async (req) => {
      const body = await context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const panelId = typeof body.id === 'string' ? body.id : '';
      const pane = body.pane === 'bottom' ? 'bottom' : 'top';
      if (!panelId) return Response.json({ error: 'Missing panel id' }, { status: 400 });
      const ok = context.integrationHelpers?.openPanel(panelId, pane) ?? false;
      return ok
        ? Response.json({ opened: true, id: panelId, pane })
        : Response.json({ error: `Unknown panel: ${panelId}` }, { status: 404 });
    },
    getEvents: (req) => {
      const url = new URL(req.url);
      const rawDomains = url.searchParams.get('domains');
      const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as import('../../runtime/events/index.ts').RuntimeEventDomain[];
      return withHelpers(context.integrationHelpers, (helpers) => helpers.createEventStream(req, domains));
    },
  };
}

function withHelpers<T>(
  helpers: IntegrationHelperService | null | undefined,
  run: (helpers: IntegrationHelperService) => T,
): T | Response {
  if (!helpers) {
    return Response.json({ error: 'Integration helper service unavailable' }, { status: 503 });
  }
  return run(helpers);
}
