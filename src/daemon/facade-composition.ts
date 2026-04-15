import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { ServiceRegistry } from '../config/service-registry.ts';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import {
  AutomationDeliveryManager,
  AutomationManager,
} from '@pellux/goodvibes-sdk/platform/automation/index';
import { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
} from '@pellux/goodvibes-sdk/platform/channels/index';
import { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { PlatformServiceManager } from '@pellux/goodvibes-sdk/platform/daemon/service-manager';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers/index';
import { type DistributedPeerAuth } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import { KnowledgeGraphqlService, KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import { DaemonControlPlaneHelper } from '@pellux/goodvibes-sdk/platform/daemon/control-plane';
import { DaemonSurfaceDeliveryHelper } from './surface-delivery.ts';
import { DaemonSurfaceActionHelper } from './surface-actions.ts';
import { DaemonTransportEventsHelper } from '@pellux/goodvibes-sdk/platform/daemon/transport-events';
import { DaemonHttpRouter } from './http/router.ts';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.ts';
import type { DaemonConfig, PendingSurfaceReply } from './types.ts';
import type { ResolvedInboundTlsContext } from '@pellux/goodvibes-sdk/platform/runtime/network/index';

type JsonBody = Record<string, unknown>;

export interface ResolvedDaemonFacadeRuntime {
  readonly configManager: ConfigManager;
  readonly runtimeServices: RuntimeServices;
  readonly integrationHelpers: IntegrationHelperService;
  readonly port: number;
  readonly host: string;
  readonly agentManager: AgentManager;
  readonly userAuth: UserAuthManager;
  readonly automationManager: AutomationManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeServices['runtimeStore'];
  readonly runtimeDispatch: RuntimeServices['runtimeDispatch'];
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly sessionBroker: SharedSessionBroker;
  readonly approvalBroker: ApprovalBroker;
  readonly routeBindings: RouteBindingManager;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly watcherRegistry: WatcherRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  readonly voiceService: RuntimeServices['voiceService'];
  readonly webSearchService: RuntimeServices['webSearchService'];
  readonly knowledgeService: KnowledgeService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: RuntimeServices['mediaProviders'];
  readonly multimodalService: RuntimeServices['multimodalService'];
  readonly artifactStore: RuntimeServices['artifactStore'];
  readonly serviceRegistry: ServiceRegistry;
  readonly serveFactory: typeof Bun.serve;
  readonly githubWebhookSecret: string | null;
}

export function resolveDaemonFacadeRuntime(
  config: DaemonConfig,
  fallbackConfigManager?: ConfigManager,
): ResolvedDaemonFacadeRuntime {
  const ownedWorkingDir = config.runtimeServices?.workingDirectory ?? config.workingDir;
  const ownedHomeDirectory = config.runtimeServices?.homeDirectory ?? config.homeDirectory;
  const configManager = config.configManager ?? fallbackConfigManager ?? config.runtimeServices?.configManager;
  if (!config.runtimeServices && !configManager && (!ownedWorkingDir || !ownedHomeDirectory)) {
    throw new Error('DaemonServer requires explicit runtime services or explicit configManager plus workingDir/homeDirectory ownership.');
  }
  if (!config.runtimeServices && !configManager) {
    throw new Error('DaemonServer requires an explicit ConfigManager or runtimeServices.');
  }

  const resolvedConfigManager = configManager ?? config.runtimeServices!.configManager;
  const ownedRuntimeBus = config.runtimeServices?.runtimeBus ?? config.runtimeBus ?? new RuntimeEventBus();
  const runtimeServices = config.runtimeServices ?? createRuntimeServices({
    configManager: resolvedConfigManager,
    runtimeBus: ownedRuntimeBus,
    runtimeStore: createRuntimeStore(),
    getConversationTitle: () => 'goodvibes daemon',
    workingDir: ownedWorkingDir!,
    homeDirectory: ownedHomeDirectory!,
  });
  const runtimeBus = runtimeServices.runtimeBus;
  const runtimeStore = runtimeServices.runtimeStore;
  const controlPlaneGateway = new ControlPlaneGateway({
    runtimeBus,
    runtimeStore,
    server: {
      enabled: false,
      host: config.host ?? String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
      port: config.port ?? Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
      streamingMode: (resolvedConfigManager.get('controlPlane.streamMode') as import('../control-plane/index.ts').ControlPlaneStreamingMode | undefined) ?? 'sse',
    },
  });

  runtimeServices.knowledgeService.attachRuntimeBus(runtimeBus);
  runtimeServices.routeBindings.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.surfaceRegistry.attachRuntime(runtimeStore);
  runtimeServices.watcherRegistry.attachRuntime({
    runtimeBus,
    runtimeStore,
  });
  runtimeServices.automationManager.attachRuntime({
    runtimeBus,
    runtimeStore,
    deliveryManager: runtimeServices.deliveryManager,
  });
  runtimeServices.deliveryManager.setControlPlaneGateway(controlPlaneGateway);
  runtimeServices.approvalBroker.setPublisher(controlPlaneGateway);
  runtimeServices.sessionBroker.setEventPublisher((event, payload) => {
    controlPlaneGateway.publishEvent(event, payload);
  });

  return {
    configManager: resolvedConfigManager,
    runtimeServices,
    integrationHelpers: runtimeServices.integrationHelpers,
    port: config.port ?? Number(resolvedConfigManager.get('controlPlane.port') ?? 3421),
    host: config.host ?? String(resolvedConfigManager.get('controlPlane.host') ?? '127.0.0.1'),
    agentManager: config.agentManager ?? runtimeServices.agentManager,
    userAuth: config.userAuth ?? runtimeServices.localUserAuthManager,
    automationManager: runtimeServices.automationManager,
    runtimeBus,
    runtimeStore,
    runtimeDispatch: runtimeServices.runtimeDispatch,
    controlPlaneGateway,
    gatewayMethods: runtimeServices.gatewayMethods,
    sessionBroker: runtimeServices.sessionBroker,
    approvalBroker: runtimeServices.approvalBroker,
    routeBindings: runtimeServices.routeBindings,
    deliveryManager: runtimeServices.deliveryManager,
    surfaceRegistry: runtimeServices.surfaceRegistry,
    channelPolicy: runtimeServices.channelPolicy,
    channelPlugins: runtimeServices.channelPlugins,
    watcherRegistry: runtimeServices.watcherRegistry,
    platformServiceManager: new PlatformServiceManager(resolvedConfigManager, {
      workingDirectory: runtimeServices.workingDirectory,
      homeDirectory: runtimeServices.homeDirectory,
      surfaceRoot: 'tui',
    }),
    distributedRuntime: runtimeServices.distributedRuntime,
    voiceService: runtimeServices.voiceService,
    webSearchService: runtimeServices.webSearchService,
    knowledgeService: runtimeServices.knowledgeService,
    knowledgeGraphqlService: new KnowledgeGraphqlService(runtimeServices.knowledgeService),
    mediaProviders: runtimeServices.mediaProviders,
    multimodalService: runtimeServices.multimodalService,
    artifactStore: runtimeServices.artifactStore,
    serviceRegistry: runtimeServices.serviceRegistry,
    serveFactory: config.serveFactory ?? Bun.serve,
    githubWebhookSecret: config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null,
  };
}

export interface DaemonFacadeCollaborators {
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly controlPlaneHelper: DaemonControlPlaneHelper;
  readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
  readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  readonly transportEventsHelper: DaemonTransportEventsHelper;
  readonly httpRouter: DaemonHttpRouter;
  readonly providerRuntime: ChannelProviderRuntimeManager;
  readonly builtinChannels: BuiltinChannelRuntime;
}

export interface CreateDaemonFacadeCollaboratorsOptions {
  readonly runtime: ResolvedDaemonFacadeRuntime;
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly authToken: () => string | null;
  readonly trustProxyEnabled: () => boolean;
  readonly dispatchApiRoutes: (req: Request) => Promise<Response | null>;
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.ts').AgentRecord | Response;
  readonly checkAuth: (req: Request) => boolean;
  readonly extractAuthToken: (req: Request) => string;
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
  readonly syncSpawnedAgentTask: (record: import('../tools/agent/index.ts').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../tools/agent/index.ts').AgentRecord) => void;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (approvalId: string, action: 'claim' | 'approve' | 'deny' | 'cancel', req: Request) => Promise<Response>;
  readonly tlsState: () => ResolvedInboundTlsContext | null;
}

export function createDaemonFacadeCollaborators(
  options: CreateDaemonFacadeCollaboratorsOptions,
): DaemonFacadeCollaborators {
  const { runtime } = options;
  const channelReplyPipeline = new ChannelReplyPipeline({
    channelPlugins: runtime.channelPlugins,
    routeBindings: runtime.routeBindings,
    runtimeBus: runtime.runtimeBus,
  });
  const surfaceDeliveryHelper = new DaemonSurfaceDeliveryHelper({
    pendingSurfaceReplies: options.pendingSurfaceReplies,
    channelReplyPipeline,
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    agentManager: runtime.agentManager,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPlugins: runtime.channelPlugins,
    authToken: options.authToken,
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
  });
  const surfaceActionHelper = new DaemonSurfaceActionHelper({
    serviceRegistry: runtime.serviceRegistry,
    configManager: runtime.configManager,
    routeBindings: runtime.routeBindings,
    sessionBroker: runtime.sessionBroker,
    channelPolicy: runtime.channelPolicy,
    automationManager: runtime.automationManager,
    agentManager: runtime.agentManager,
    trySpawnAgent: options.trySpawnAgent,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    queueWebhookReply: (input) => surfaceDeliveryHelper.queueWebhookReply(input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    signWebhookPayload: options.signWebhookPayload,
    handleApprovalAction: options.handleApprovalAction,
  });
  const controlPlaneHelper = new DaemonControlPlaneHelper({
    authToken: options.authToken,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    host: runtime.host,
    port: runtime.port,
    distributedRuntime: runtime.distributedRuntime,
    trustProxyEnabled: options.trustProxyEnabled,
    dispatchApiRoutes: options.dispatchApiRoutes,
    parseJsonBody: options.parseJsonBody,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
  });
  const transportEventsHelper = new DaemonTransportEventsHelper({
    runtimeBus: runtime.runtimeBus,
    hookDispatcher: runtime.runtimeServices.hookDispatcher,
    host: runtime.host,
    port: runtime.port,
    tlsState: options.tlsState,
  });
  const httpRouter = new DaemonHttpRouter({
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    userAuth: runtime.userAuth,
    agentManager: runtime.agentManager,
    automationManager: runtime.automationManager,
    approvalBroker: runtime.approvalBroker,
    controlPlaneGateway: runtime.controlPlaneGateway,
    gatewayMethods: runtime.gatewayMethods,
    providerRegistry: runtime.runtimeServices.providerRegistry,
    sessionBroker: runtime.sessionBroker,
    routeBindings: runtime.routeBindings,
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    surfaceRegistry: runtime.surfaceRegistry,
    distributedRuntime: runtime.distributedRuntime,
    watcherRegistry: runtime.watcherRegistry,
    voiceService: runtime.voiceService,
    webSearchService: runtime.webSearchService,
    knowledgeService: runtime.knowledgeService,
    knowledgeGraphqlService: runtime.knowledgeGraphqlService,
    mediaProviders: runtime.mediaProviders,
    multimodalService: runtime.multimodalService,
    artifactStore: runtime.artifactStore,
    memoryRegistry: runtime.runtimeServices.memoryRegistry,
    memoryEmbeddingRegistry: runtime.runtimeServices.memoryEmbeddingRegistry,
    platformServiceManager: runtime.platformServiceManager,
    integrationHelpers: runtime.integrationHelpers,
    runtimeBus: runtime.runtimeBus,
    runtimeStore: runtime.runtimeStore,
    runtimeDispatch: runtime.runtimeDispatch,
    githubWebhookSecret: runtime.githubWebhookSecret,
    authToken: options.authToken,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    checkAuth: options.checkAuth,
    extractAuthToken: options.extractAuthToken,
    requireAuthenticatedSession: options.requireAuthenticatedSession,
    requireAdmin: options.requireAdmin,
    requireRemotePeer: options.requireRemotePeer,
    describeAuthenticatedPrincipal: options.describeAuthenticatedPrincipal,
    invokeGatewayMethodCall: options.invokeGatewayMethodCall,
    queueSurfaceReplyFromBinding: (binding, input) => surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    syncSpawnedAgentTask: options.syncSpawnedAgentTask,
    syncFinishedAgentTask: options.syncFinishedAgentTask,
    trySpawnAgent: options.trySpawnAgent,
  });
  const providerRuntime = new ChannelProviderRuntimeManager({
    configManager: runtime.configManager,
    serviceRegistry: runtime.serviceRegistry,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
  });
  const builtinChannels = new BuiltinChannelRuntime({
    configManager: runtime.configManager,
    secretsManager: runtime.runtimeServices.secretsManager,
    serviceRegistry: runtime.serviceRegistry,
    routeBindings: runtime.routeBindings,
    channelPolicy: runtime.channelPolicy,
    channelPlugins: runtime.channelPlugins,
    providerRuntime,
    deliveryRouter: runtime.deliveryManager.getDeliveryRouter(),
    surfaceDeliveryEnabled: options.surfaceDeliveryEnabled,
    buildSurfaceAdapterContext: () => surfaceActionHelper.buildSurfaceAdapterContext(),
    buildGenericWebhookAdapterContext: () => surfaceActionHelper.buildGenericWebhookAdapterContext(),
    deliverSurfaceProgress: (pending, progress) => surfaceDeliveryHelper.deliverSurfaceProgress(pending as PendingSurfaceReply, progress),
    deliverSlackAgentReply: (pending, message) => surfaceDeliveryHelper.deliverSlackAgentReply(pending as PendingSurfaceReply, message),
    deliverDiscordAgentReply: (pending, message) => surfaceDeliveryHelper.deliverDiscordAgentReply(pending as PendingSurfaceReply, message),
    deliverNtfyAgentReply: (pending, message) => surfaceDeliveryHelper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
    deliverWebhookAgentReply: (pending, message) => surfaceDeliveryHelper.deliverWebhookAgentReply(pending as PendingSurfaceReply, message),
    deliverSlackApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverSlackApprovalUpdate(approval, binding),
    deliverDiscordApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverDiscordApprovalUpdate(approval, binding),
    deliverNtfyApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverNtfyApprovalUpdate(approval, binding),
    deliverWebhookApprovalUpdate: (approval, binding) => surfaceDeliveryHelper.deliverWebhookApprovalUpdate(approval, binding),
  });
  builtinChannels.registerPlugins();

  return {
    channelReplyPipeline,
    controlPlaneHelper,
    surfaceDeliveryHelper,
    surfaceActionHelper,
    transportEventsHelper,
    httpRouter,
    providerRuntime,
    builtinChannels,
  };
}

export function configureDaemonSessionContinuation(options: {
  readonly sessionBroker: SharedSessionBroker;
  readonly trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => import('../tools/agent/index.ts').AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding | undefined, input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string;
  }) => void;
}): void {
  options.sessionBroker.setContinuationRunner(async ({ sessionId, input, task, routeBinding }) => {
    const spawned = options.trySpawnAgent({
      mode: 'spawn',
      task,
      ...(input.routing?.modelId ? { model: input.routing.modelId } : {}),
      ...(input.routing?.providerId ? { provider: input.routing.providerId } : {}),
      ...(input.routing?.tools?.length ? { tools: [...input.routing.tools] } : {}),
      context: `shared-session:${sessionId}`,
    }, 'DaemonServer.sharedSessionFollowUp', sessionId);
    if (spawned instanceof Response) {
      return null;
    }
    options.queueSurfaceReplyFromBinding(routeBinding, {
      agentId: spawned.id,
      task: input.body,
      sessionId,
    });
    return { agentId: spawned.id };
  });
}
