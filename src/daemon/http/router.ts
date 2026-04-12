import type { ConfigManager } from '../../config/manager.ts';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { UserAuthManager } from '../../security/user-auth.ts';
import type { AgentManager } from '../../tools/agent/index.ts';
import type { AutomationManager } from '../../automation/index.ts';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../../control-plane/index.ts';
import type { GatewayMethodCatalog } from '../../control-plane/index.ts';
import type { ProviderRegistry } from '../../providers/registry.ts';
import type { RouteBindingManager, ChannelPolicyManager, ChannelPluginRegistry, SurfaceRegistry } from '../../channels/index.ts';
import type { WatcherRegistry } from '../../watchers/index.ts';
import type { DistributedPeerAuth, DistributedRuntimeManager } from '../../runtime/remote/index.ts';
import type { KnowledgeGraphqlService, KnowledgeService } from '../../knowledge/index.ts';
import type { VoiceService } from '../../voice/index.ts';
import type { WebSearchService } from '../../web-search/index.ts';
import type { ArtifactStore } from '../../artifacts/index.ts';
import type { MediaProviderRegistry } from '../../media/index.ts';
import type { MultimodalService } from '../../multimodal/index.ts';
import type { IntegrationHelperService } from '../../runtime/integration/helpers.ts';
import type { DomainDispatch, RuntimeStore } from '../../runtime/store/index.ts';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../../state/index.ts';
import { dispatchDaemonApiRoutes } from '../../control-plane/routes/index.ts';
import { handleGitHubAutomationWebhook, handleSlackSurfaceWebhook, handleDiscordSurfaceWebhook, handleNtfySurfaceWebhook, handleGenericWebhookSurface } from '../../adapters/index.ts';
import { createDaemonKnowledgeRouteHandlers } from './knowledge-routes.ts';
import { createDaemonMediaRouteHandlers } from './media-routes.ts';
import {
  createDaemonRemoteRouteHandlers,
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
} from './remote-routes.ts';
import { createDaemonRuntimeRouteHandlers } from './runtime-routes.ts';
import { createDaemonControlRouteHandlers } from './control-routes.ts';
import { createDaemonIntegrationRouteHandlers } from './integration-routes.ts';
import { createDaemonChannelRouteHandlers } from './channel-routes.ts';
import { createDaemonSystemRouteHandlers } from './system-routes.ts';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../../adapters/index.ts';
import type { PlatformServiceManager } from '../service-manager.ts';
import type { JsonRecord } from '../helpers.ts';

interface DaemonHttpRouterContext {
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly watcherRegistry: WatcherRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchService: WebSearchService;
  readonly knowledgeService: KnowledgeService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly artifactStore: ArtifactStore;
  readonly memoryRegistry: MemoryRegistry;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
  readonly githubWebhookSecret: string | null;
  readonly authToken: () => string | null;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly checkAuth: (req: Request) => boolean;
  readonly extractAuthToken: (req: Request) => string;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly describeAuthenticatedPrincipal: (token: string) => {
    principalId: string;
    principalKind: 'user' | 'bot' | 'service' | 'token';
    admin: boolean;
    scopes: readonly string[];
  } | null;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalId?: string;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
      readonly clientKind?: string;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('../../automation/routes.ts').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly sessionId?: string },
  ) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly syncSpawnedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../../tools/agent/index.ts').AgentRecord) => void;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => import('../../tools/agent/index.ts').AgentRecord | Response;
}

export class DaemonHttpRouter {
  constructor(private readonly context: DaemonHttpRouterContext) {}

  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }

    if (url.pathname === '/api/remote/pair/request' && req.method === 'POST') {
      return handleRemotePairRequest({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/pair/verify' && req.method === 'POST') {
      return handleRemotePairVerify({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/heartbeat' && req.method === 'POST') {
      return handleRemotePeerHeartbeat({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/work/pull' && req.method === 'POST') {
      return handleRemotePeerWorkPull({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    const remoteWorkCompleteMatch = url.pathname.match(/^\/api\/remote\/work\/([^/]+)\/complete$/);
    if (remoteWorkCompleteMatch && req.method === 'POST') {
      return handleRemotePeerWorkComplete({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, remoteWorkCompleteMatch[1], req);
    }

    if (url.pathname === '/webhook/github' && req.method === 'POST') {
      return this.handleGitHubWebhook(req);
    }
    if (url.pathname.startsWith('/webhook/')) {
      const pluginResponse = await this.context.channelPlugins.handleInbound(url.pathname, req);
      if (pluginResponse) return pluginResponse;
    }

    if (url.pathname === '/api/control-plane/web' && req.method === 'GET' && !this.context.authToken()) {
      if (!this.context.checkAuth(req)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return this.context.controlPlaneGateway.renderWebUi(this.context.extractAuthToken(req));
    }

    if (!this.context.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiResponse = await this.dispatchApiRoutes(req);
    if (apiResponse) return apiResponse;
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  async dispatchApiRoutes(req: Request): Promise<Response | null> {
    return dispatchDaemonApiRoutes(req, {
      ...createDaemonControlRouteHandlers({
        authToken: this.context.authToken(),
        configManager: this.context.configManager,
        controlPlaneGateway: this.context.controlPlaneGateway,
        describeAuthenticatedPrincipal: this.context.describeAuthenticatedPrincipal,
        extractAuthToken: this.context.extractAuthToken,
        gatewayMethods: this.context.gatewayMethods,
        invokeGatewayMethodCall: this.context.invokeGatewayMethodCall,
        requireAdmin: this.context.requireAdmin,
        requireAuthenticatedSession: this.context.requireAuthenticatedSession,
      }, req),
      ...createDaemonIntegrationRouteHandlers({
        channelPlugins: this.context.channelPlugins,
        configManager: this.context.configManager,
        integrationHelpers: this.context.integrationHelpers,
        memoryEmbeddingRegistry: this.context.memoryEmbeddingRegistry,
        memoryRegistry: this.context.memoryRegistry,
        parseJsonBody: (request) => this.parseJsonBody(request),
        providerRegistry: this.context.providerRegistry,
        requireAdmin: (request) => this.context.requireAdmin(request),
        userAuth: this.context.userAuth,
      }, req),
      ...createDaemonChannelRouteHandlers({
        channelPlugins: this.context.channelPlugins,
        channelPolicy: this.context.channelPolicy,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
        surfaceRegistry: this.context.surfaceRegistry,
      }),
      ...createDaemonSystemRouteHandlers({
        approvalBroker: this.context.approvalBroker,
        configManager: this.context.configManager,
        integrationHelpers: this.context.integrationHelpers,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        platformServiceManager: this.context.platformServiceManager,
        recordApiResponse: (request, path, response, clientKind) => this.recordApiResponse(request, path, response, clientKind),
        requireAdmin: (request) => this.context.requireAdmin(request),
        requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
        routeBindings: this.context.routeBindings,
        watcherRegistry: this.context.watcherRegistry,
      }, req),
      ...createDaemonRuntimeRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        recordApiResponse: (request, path, response) => this.recordApiResponse(request, path, response),
        requireAdmin: (request) => this.context.requireAdmin(request),
        sessionBroker: {
          start: () => this.context.sessionBroker.start(),
          submitMessage: (input) => this.context.sessionBroker.submitMessage(input),
          bindAgent: async (sessionId, agentId) => {
            await this.context.sessionBroker.bindAgent(sessionId, agentId);
          },
          createSession: (input) => this.context.sessionBroker.createSession(input),
          getSession: (sessionId) => this.context.sessionBroker.getSession(sessionId),
          getMessages: (sessionId, limit) => this.context.sessionBroker.getMessages(sessionId, limit),
          closeSession: (sessionId) => this.context.sessionBroker.closeSession(sessionId),
          reopenSession: (sessionId) => this.context.sessionBroker.reopenSession(sessionId),
          completeAgent: async (sessionId, agentId, message, meta) => {
            await this.context.sessionBroker.completeAgent(sessionId, agentId, message, meta);
          },
        },
        agentManager: {
          getStatus: (agentId) => this.context.agentManager.getStatus(agentId),
          cancel: (agentId) => this.context.agentManager.cancel(agentId),
        },
        automationManager: {
          listJobs: () => this.context.automationManager.listJobs(),
          listRuns: () => this.context.automationManager.listRuns(),
          getRun: (runId) => this.context.automationManager.getRun(runId) ?? null,
          triggerHeartbeat: (input) => this.context.automationManager.triggerHeartbeat(input),
          cancelRun: (runId, reason) => this.context.automationManager.cancelRun(runId, reason),
          retryRun: (runId) => this.context.automationManager.retryRun(runId),
          createJob: (input) => this.context.automationManager.createJob(input as unknown as import('../../automation/index.ts').CreateAutomationJobInput),
          updateJob: (jobId, input) => this.context.automationManager.updateJob(jobId, input as unknown as import('../../automation/index.ts').UpdateAutomationJobInput),
          removeJob: async (jobId) => {
            await this.context.automationManager.removeJob(jobId);
          },
          setEnabled: (jobId, enabled) => this.context.automationManager.setEnabled(jobId, enabled),
          runNow: (jobId) => this.context.automationManager.runNow(jobId),
        },
        routeBindings: this.context.routeBindings,
        trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent({
          ...input,
          ...(input.tools ? { tools: [...input.tools] } : {}),
        } as Parameters<AgentManager['spawn']>[0], logLabel, sessionId),
        queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(binding, input),
        surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
        syncSpawnedAgentTask: (record, sessionId) => this.context.syncSpawnedAgentTask(record, sessionId),
        syncFinishedAgentTask: (record) => this.context.syncFinishedAgentTask(record),
        configManager: this.context.configManager,
        runtimeStore: this.context.runtimeStore,
        runtimeDispatch: this.context.runtimeDispatch,
      }),
      ...createDaemonRemoteRouteHandlers({
        authToken: this.context.authToken(),
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
        distributedRuntime: this.context.distributedRuntime,
      }),
      ...createDaemonKnowledgeRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        parseJsonText: (raw) => this.parseJsonText(raw),
        requireAdmin: (request) => this.context.requireAdmin(request),
        describeAuthenticatedPrincipal: (token) => this.context.describeAuthenticatedPrincipal(token),
        extractAuthToken: (request) => this.context.extractAuthToken(request),
        knowledgeService: this.context.knowledgeService,
        knowledgeGraphqlService: this.context.knowledgeGraphqlService,
      }),
      ...createDaemonMediaRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        voiceService: this.context.voiceService,
        configManager: this.context.configManager,
        webSearchService: this.context.webSearchService,
        artifactStore: this.context.artifactStore,
        mediaProviders: this.context.mediaProviders,
        multimodalService: this.context.multimodalService,
      }),
    });
  }

  async parseJsonBody(req: Request): Promise<JsonRecord | Response> {
    try {
      return await req.json() as JsonRecord;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  async parseOptionalJsonBody(req: Request): Promise<JsonRecord | null | Response> {
    const raw = await req.text();
    if (!raw.trim()) return null;
    return this.parseJsonText(raw);
  }

  parseJsonText(rawBody: string): JsonRecord | Response {
    try {
      return JSON.parse(rawBody) as JsonRecord;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  recordApiResponse(
    req: Request,
    path: string,
    response: Response,
    clientKind:
      | 'web'
      | 'slack'
      | 'discord'
      | 'ntfy'
      | 'webhook'
      | 'telegram'
      | 'google-chat'
      | 'signal'
      | 'whatsapp'
      | 'imessage'
      | 'msteams'
      | 'bluebubbles'
      | 'mattermost'
      | 'matrix'
      | 'daemon' = 'web',
  ): Response {
    this.context.controlPlaneGateway.recordApiRequest({
      method: req.method,
      path,
      status: response.status,
      clientKind,
      ...(response.status >= 400 ? { error: `${req.method} ${path} -> ${response.status}` } : {}),
    });
    return response;
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.context.userAuth.authenticate(username, password);

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.context.userAuth.createSession(user.username);
    return Response.json({
      authenticated: true,
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
    });
  }

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    return handleGitHubAutomationWebhook(req, {
      serviceRegistry: this.context.serviceRegistry,
      githubWebhookSecret: this.context.githubWebhookSecret,
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
    });
  }

  async handleSlackWebhook(req: Request): Promise<Response> {
    return handleSlackSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleDiscordWebhook(req: Request): Promise<Response> {
    return handleDiscordSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleNtfyWebhook(req: Request): Promise<Response> {
    return handleNtfySurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleGenericWebhook(req: Request): Promise<Response> {
    return handleGenericWebhookSurface(req, this.context.buildGenericWebhookAdapterContext());
  }
}
