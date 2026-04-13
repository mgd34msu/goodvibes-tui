import { logger } from '../utils/logger.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import {
  AutomationDeliveryManager,
  AutomationManager,
} from '../automation/index.ts';
import { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.ts';
import { GatewayMethodCatalog } from '../control-plane/index.ts';
import {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
  type ChannelSurface,
} from '../channels/index.ts';
import { RuntimeEventBus } from '../runtime/events/index.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import { PlatformServiceManager } from './service-manager.ts';
import { WatcherRegistry } from '../watchers/index.ts';
import { type DistributedPeerAuth } from '../runtime/remote/index.ts';
import { KnowledgeGraphqlService, KnowledgeService } from '../knowledge/index.ts';
import type { IntegrationHelperService } from '../runtime/integration/helpers.ts';
import { DaemonControlPlaneHelper, type ControlPlaneWebSocketData } from './control-plane.ts';
import { DaemonSurfaceDeliveryHelper } from './surface-delivery.ts';
import { DaemonSurfaceActionHelper } from './surface-actions.ts';
import { DaemonTransportEventsHelper } from './transport-events.ts';
import { DaemonHttpRouter } from './http/router.ts';
import { isSurfaceDeliveryEnabled } from './surface-policy.ts';
import {
  GlobalNetworkTransportInstaller,
  resolveInboundTlsContext,
  type ResolvedInboundTlsContext,
} from '../runtime/network/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.ts';
import {
  readAutomationReasoningEffort,
  readAutomationWakeMode,
  readExternalContentSource,
  readStringList,
} from './helpers.ts';
import type { DaemonConfig, DaemonDangerConfig, PendingSurfaceReply } from './types.ts';

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

type JsonBody = Record<string, unknown>;

// ---------------------------------------------------------------------------
// DaemonServer
// ---------------------------------------------------------------------------

/**
 * DaemonServer — HTTP task server, disabled by default.
 *
 * Enable via: danger.daemon = true in config.
 * All routes require Bearer token auth (set via enable()).
 * POST /task    — submit a task; returns agentId.
 * GET  /task/:id — returns agent status.
 * GET  /status  — server health check.
 */
export class DaemonServer {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private agentManager: AgentManager;
  private readonly runtimeServices: RuntimeServices;
  private readonly integrationHelpers: IntegrationHelperService;
  private configManager: ConfigManager;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private githubWebhookSecret: string | null;
  private automationManager: AutomationManager;
  private runtimeBus: RuntimeEventBus;
  private readonly runtimeStore: RuntimeServices['runtimeStore'];
  private readonly runtimeDispatch: RuntimeServices['runtimeDispatch'];
  private readonly controlPlaneGateway: ControlPlaneGateway;
  private readonly gatewayMethods: GatewayMethodCatalog;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly approvalBroker: ApprovalBroker;
  private readonly routeBindings: RouteBindingManager;
  private readonly deliveryManager: AutomationDeliveryManager;
  private readonly surfaceRegistry: SurfaceRegistry;
  private readonly channelPolicy: ChannelPolicyManager;
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly channelReplyPipeline: ChannelReplyPipeline;
  private readonly providerRuntime: ChannelProviderRuntimeManager;
  private readonly builtinChannels: BuiltinChannelRuntime;
  private readonly watcherRegistry: WatcherRegistry;
  private readonly platformServiceManager: PlatformServiceManager;
  private readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  private readonly voiceService: RuntimeServices['voiceService'];
  private readonly webSearchService: RuntimeServices['webSearchService'];
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  private readonly mediaProviders: RuntimeServices['mediaProviders'];
  private readonly multimodalService: RuntimeServices['multimodalService'];
  private readonly artifactStore: RuntimeServices['artifactStore'];
  private readonly serviceRegistry: ServiceRegistry;
  private readonly serveFactory: typeof Bun.serve;
  private readonly pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  private readonly controlPlaneHelper: DaemonControlPlaneHelper;
  private readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
  private readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  private readonly transportEventsHelper: DaemonTransportEventsHelper;
  private readonly httpRouter: DaemonHttpRouter;
  private replyPoller: ReturnType<typeof setInterval> | null = null;
  private tlsState: ResolvedInboundTlsContext | null = null;

  constructor(private config: DaemonConfig = {}, _configManager?: ConfigManager) {
    const ownedWorkingDir = config.runtimeServices?.workingDirectory ?? config.workingDir;
    const ownedHomeDirectory = config.runtimeServices?.homeDirectory ?? config.homeDirectory;
    const configManager = config.configManager ?? _configManager ?? config.runtimeServices?.configManager;
    if (!config.runtimeServices && !configManager && (!ownedWorkingDir || !ownedHomeDirectory)) {
      throw new Error('DaemonServer requires explicit runtime services or explicit configManager plus workingDir/homeDirectory ownership.');
    }
    if (!config.runtimeServices && !configManager) {
      throw new Error('DaemonServer requires an explicit ConfigManager or runtimeServices.');
    }
    this.configManager = configManager ?? config.runtimeServices!.configManager;
    const ownedRuntimeBus = config.runtimeServices?.runtimeBus ?? config.runtimeBus ?? new RuntimeEventBus();
    this.runtimeServices = config.runtimeServices ?? createRuntimeServices({
      configManager: this.configManager,
      runtimeBus: ownedRuntimeBus,
      runtimeStore: createRuntimeStore(),
      getConversationTitle: () => 'goodvibes daemon',
      workingDir: ownedWorkingDir!,
      homeDirectory: ownedHomeDirectory!,
    });
    this.integrationHelpers = this.runtimeServices.integrationHelpers;
    this.port = config.port ?? Number(this.configManager.get('controlPlane.port') ?? 3421);
    this.host = config.host ?? String(this.configManager.get('controlPlane.host') ?? '127.0.0.1');
    this.agentManager = config.agentManager ?? this.runtimeServices.agentManager;
    this.userAuth = config.userAuth ?? this.runtimeServices.localUserAuthManager;
    this.serveFactory = config.serveFactory ?? Bun.serve;
    this.serviceRegistry = this.runtimeServices.serviceRegistry;
    this.runtimeBus = this.runtimeServices.runtimeBus;
    this.runtimeStore = this.runtimeServices.runtimeStore;
    this.runtimeDispatch = this.runtimeServices.runtimeDispatch;
    this.artifactStore = this.runtimeServices.artifactStore;
    this.knowledgeService = this.runtimeServices.knowledgeService;
    this.knowledgeGraphqlService = new KnowledgeGraphqlService(this.knowledgeService);
    this.voiceService = this.runtimeServices.voiceService;
    this.webSearchService = this.runtimeServices.webSearchService;
    this.mediaProviders = this.runtimeServices.mediaProviders;
    this.multimodalService = this.runtimeServices.multimodalService;
    this.platformServiceManager = new PlatformServiceManager(this.configManager, {
      workingDirectory: this.runtimeServices.workingDirectory,
      homeDirectory: this.runtimeServices.homeDirectory,
    });
    // Webhook secrets follow 12-factor app conventions (https://12factor.net/config):
    // prefer explicit config object values (e.g. from a vault-injected object) and
    // fall back to environment variables so the binary works in any deployment
    // without code changes. Secrets are never logged or exposed via the API.
    this.githubWebhookSecret =
      config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null;
    this.automationManager = this.runtimeServices.automationManager;
    this.gatewayMethods = this.runtimeServices.gatewayMethods;
    this.sessionBroker = this.runtimeServices.sessionBroker;
    this.approvalBroker = this.runtimeServices.approvalBroker;
    this.knowledgeService.attachRuntimeBus(this.runtimeBus);
    this.routeBindings = this.runtimeServices.routeBindings;
    this.routeBindings.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.surfaceRegistry = this.runtimeServices.surfaceRegistry;
    this.channelPolicy = this.runtimeServices.channelPolicy;
    this.channelPlugins = this.runtimeServices.channelPlugins;
    this.channelReplyPipeline = new ChannelReplyPipeline({
      channelPlugins: this.channelPlugins,
      routeBindings: this.routeBindings,
      runtimeBus: this.runtimeBus,
    });
    this.surfaceRegistry.attachRuntime(this.runtimeStore);
    this.watcherRegistry = this.runtimeServices.watcherRegistry;
    this.watcherRegistry.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.deliveryManager = this.runtimeServices.deliveryManager;
    this.automationManager.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
      deliveryManager: this.deliveryManager,
    });
    this.distributedRuntime = this.runtimeServices.distributedRuntime;
    this.controlPlaneGateway = new ControlPlaneGateway({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
      server: {
        enabled: false,
        host: this.host,
        port: this.port,
        streamingMode: (this.configManager.get('controlPlane.streamMode') as import('../control-plane/index.ts').ControlPlaneStreamingMode | undefined) ?? 'sse',
      },
    });
    this.deliveryManager.setControlPlaneGateway(this.controlPlaneGateway);
    this.approvalBroker.setPublisher(this.controlPlaneGateway);
    this.sessionBroker.setEventPublisher((event, payload) => {
      this.controlPlaneGateway.publishEvent(event, payload);
    });
    this.controlPlaneHelper = new DaemonControlPlaneHelper({
      authToken: () => this.authToken,
      userAuth: this.userAuth,
      agentManager: this.agentManager,
      controlPlaneGateway: this.controlPlaneGateway,
      gatewayMethods: this.gatewayMethods,
      host: this.host,
      port: this.port,
      distributedRuntime: this.distributedRuntime,
      trustProxyEnabled: () => this.trustProxyEnabled(),
      dispatchApiRoutes: (req) => this.dispatchApiRoutes(req),
      parseJsonBody: (req) => this.parseJsonBody(req),
      requireAuthenticatedSession: (req) => this.requireAuthenticatedSession(req),
    });
    this.surfaceDeliveryHelper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies: this.pendingSurfaceReplies,
      channelReplyPipeline: this.channelReplyPipeline,
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      agentManager: this.agentManager,
      sessionBroker: this.sessionBroker,
      routeBindings: this.routeBindings,
      channelPlugins: this.channelPlugins,
      authToken: () => this.authToken,
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
    });
    this.surfaceActionHelper = new DaemonSurfaceActionHelper({
      serviceRegistry: this.serviceRegistry,
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      channelPolicy: this.channelPolicy,
      automationManager: this.automationManager,
      agentManager: this.agentManager,
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
      queueWebhookReply: (input) => this.surfaceDeliveryHelper.queueWebhookReply(input),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.surfaceDeliveryHelper.signWebhookPayload(body, secret),
      handleApprovalAction: (approvalId, action, req) => this.handleApprovalAction(approvalId, action, req),
    });
    this.transportEventsHelper = new DaemonTransportEventsHelper({
      runtimeBus: this.runtimeBus,
      hookDispatcher: this.runtimeServices.hookDispatcher,
      host: this.host,
      port: this.port,
      tlsState: () => this.tlsState,
    });
    this.httpRouter = new DaemonHttpRouter({
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      userAuth: this.userAuth,
      agentManager: this.agentManager,
      automationManager: this.automationManager,
      approvalBroker: this.approvalBroker,
      controlPlaneGateway: this.controlPlaneGateway,
      gatewayMethods: this.gatewayMethods,
      providerRegistry: this.runtimeServices.providerRegistry,
      sessionBroker: this.sessionBroker,
      routeBindings: this.routeBindings,
      channelPolicy: this.channelPolicy,
      channelPlugins: this.channelPlugins,
      surfaceRegistry: this.surfaceRegistry,
      distributedRuntime: this.distributedRuntime,
      watcherRegistry: this.watcherRegistry,
      voiceService: this.voiceService,
      webSearchService: this.webSearchService,
      knowledgeService: this.knowledgeService,
      knowledgeGraphqlService: this.knowledgeGraphqlService,
      mediaProviders: this.mediaProviders,
      multimodalService: this.multimodalService,
      artifactStore: this.artifactStore,
      memoryRegistry: this.runtimeServices.memoryRegistry,
      memoryEmbeddingRegistry: this.runtimeServices.memoryEmbeddingRegistry,
      platformServiceManager: this.platformServiceManager,
      integrationHelpers: this.integrationHelpers,
      runtimeStore: this.runtimeStore,
      runtimeDispatch: this.runtimeDispatch,
      githubWebhookSecret: this.githubWebhookSecret,
      authToken: () => this.authToken,
      buildSurfaceAdapterContext: () => this.surfaceActionHelper.buildSurfaceAdapterContext(),
      buildGenericWebhookAdapterContext: () => this.surfaceActionHelper.buildGenericWebhookAdapterContext(),
      checkAuth: (req) => this.checkAuth(req),
      extractAuthToken: (req) => this.extractAuthToken(req),
      requireAuthenticatedSession: (req) => this.requireAuthenticatedSession(req),
      requireAdmin: (req) => this.requireAdmin(req),
      requireRemotePeer: (req, scope) => this.requireRemotePeer(req, scope),
      describeAuthenticatedPrincipal: (token) => this.describeAuthenticatedPrincipal(token),
      invokeGatewayMethodCall: (input) => this.invokeGatewayMethodCall(input),
      queueSurfaceReplyFromBinding: (binding, input) => this.surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      syncSpawnedAgentTask: (record, sessionId) => this.syncSpawnedAgentTask(record, sessionId),
      syncFinishedAgentTask: (record) => this.syncFinishedAgentTask(record),
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
    });
    this.approvalBroker.subscribe((approval) => {
      void this.surfaceDeliveryHelper.notifyApprovalUpdate(approval);
    });
    this.distributedRuntime.attachRuntime({
      sessionBridge: this.sessionBroker,
      approvalBridge: this.approvalBroker,
      automationBridge: this.automationManager,
      eventPublisher: (event, payload) => {
        this.controlPlaneGateway.publishEvent(event, payload);
      },
    });
    this.providerRuntime = new ChannelProviderRuntimeManager({
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      buildSurfaceAdapterContext: () => this.surfaceActionHelper.buildSurfaceAdapterContext(),
    });
    this.builtinChannels = new BuiltinChannelRuntime({
      configManager: this.configManager,
      secretsManager: this.runtimeServices.secretsManager,
      serviceRegistry: this.serviceRegistry,
      routeBindings: this.routeBindings,
      channelPolicy: this.channelPolicy,
      channelPlugins: this.channelPlugins,
      providerRuntime: this.providerRuntime,
      deliveryRouter: this.deliveryManager.getDeliveryRouter(),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      buildSurfaceAdapterContext: () => this.surfaceActionHelper.buildSurfaceAdapterContext(),
      buildGenericWebhookAdapterContext: () => this.surfaceActionHelper.buildGenericWebhookAdapterContext(),
      deliverSurfaceProgress: (pending, progress) => this.surfaceDeliveryHelper.deliverSurfaceProgress(pending as PendingSurfaceReply, progress),
      deliverSlackAgentReply: (pending, message) => this.surfaceDeliveryHelper.deliverSlackAgentReply(pending as PendingSurfaceReply, message),
      deliverDiscordAgentReply: (pending, message) => this.surfaceDeliveryHelper.deliverDiscordAgentReply(pending as PendingSurfaceReply, message),
      deliverNtfyAgentReply: (pending, message) => this.surfaceDeliveryHelper.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
      deliverWebhookAgentReply: (pending, message) => this.surfaceDeliveryHelper.deliverWebhookAgentReply(pending as PendingSurfaceReply, message),
      deliverSlackApprovalUpdate: (approval, binding) => this.surfaceDeliveryHelper.deliverSlackApprovalUpdate(approval, binding),
      deliverDiscordApprovalUpdate: (approval, binding) => this.surfaceDeliveryHelper.deliverDiscordApprovalUpdate(approval, binding),
      deliverNtfyApprovalUpdate: (approval, binding) => this.surfaceDeliveryHelper.deliverNtfyApprovalUpdate(approval, binding),
      deliverWebhookApprovalUpdate: (approval, binding) => this.surfaceDeliveryHelper.deliverWebhookApprovalUpdate(approval, binding),
    });
    this.builtinChannels.registerPlugins();
  }

  listRecentControlPlaneEvents(limit = 100): readonly import('../control-plane/gateway.ts').ControlPlaneRecentEvent[] {
    return this.controlPlaneGateway.listRecentEvents(limit);
  }

  /**
   * Enable the daemon. Requires danger.daemon = true in config.
   * The provided token is used to authenticate all incoming requests.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: DaemonDangerConfig, token?: string): boolean {
    if (!dangerConfig.daemon) {
      logger.info('DaemonServer.enable: danger.daemon is false — not enabling');
      return false;
    }
    this.enabled = true;
    this.authToken = token ?? null;
    this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port });
    return true;
  }

  /**
   * Start the daemon. Refuses to start if not explicitly enabled.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('Daemon mode is disabled. Enable via danger.daemon config.');
      return;
    }
    if (this.authToken === null) {
      logger.info('DaemonServer: starting with session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('DaemonServer: already running');
      return;
    }

    new GlobalNetworkTransportInstaller().install(this.configManager);
    this.routeBindings.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.surfaceRegistry.attachRuntime(this.runtimeStore);
    this.deliveryManager.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.automationManager.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
      deliveryManager: this.deliveryManager,
    });
    this.controlPlaneGateway.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });

    const self = this;
    this.transportEventsHelper.emitTransportInitializing();
    try {
      this.tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
      this.server = this.serveFactory({
        port: this.port,
        hostname: this.host,
        ...(this.tlsState.tls ? { tls: this.tlsState.tls } : {}),
        async fetch(req: Request, server: UpgradeCapableServer): Promise<Response | undefined> {
          const upgrade = self.tryUpgradeControlPlaneWebSocket(req, server);
          if (upgrade === 'upgraded') return;
          if (upgrade) return upgrade;
          return self.handleRequest(req);
        },
        websocket: {
          open(ws) {
            self.handleControlPlaneWebSocketOpen(ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void });
          },
          message(ws, message) {
            void self.handleControlPlaneWebSocketMessage(
              ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void },
              message,
            );
          },
          close(ws) {
            self.handleControlPlaneWebSocketClose(ws as unknown as { data: ControlPlaneWebSocketData });
          },
        },
      });

      await Promise.all([
        this.sessionBroker.start(),
        this.approvalBroker.start(),
        this.channelPolicy.start(),
        this.automationManager.start(),
        this.distributedRuntime.start(),
      ]);
      await this.providerRuntime.startConfigured();
      if (this.replyPoller === null) {
        this.replyPoller = setInterval(() => {
          void this.pollPendingSurfaceReplies();
        }, 2_000);
      }
      this.surfaceRegistry.syncConfiguredSurfaces();
      if (this.configManager.get('watchers.enabled')) {
        this.watcherRegistry.registerPollingWatcher({
          id: 'daemon-heartbeat',
          label: 'Daemon heartbeat',
          source: {
            id: 'source:daemon-heartbeat',
            kind: 'watcher',
            label: 'Daemon heartbeat',
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {},
          },
          intervalMs: Number(this.configManager.get('watchers.heartbeatIntervalMs') ?? 30_000),
          run: () => new Date().toISOString(),
        });
        this.watcherRegistry.startWatcher('daemon-heartbeat');
      }
      this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port });
      this.transportEventsHelper.emitTransportConnected();
      logger.info('DaemonServer started', {
        port: this.port,
        host: this.host,
        tlsMode: this.tlsState.mode,
        scheme: this.tlsState.scheme,
        trustProxy: this.tlsState.trustProxy,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.replyPoller !== null) {
        clearInterval(this.replyPoller);
        this.replyPoller = null;
      }
      this.pendingSurfaceReplies.clear();
      this.automationManager.stop();
      this.providerRuntime.stopAll();
      this.watcherRegistry.stopWatcher('daemon-heartbeat', 'daemon-start-failed');
      if (this.server !== null) {
        this.server.stop(true);
        this.server = null;
      }
      this.tlsState = null;
      this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
      this.transportEventsHelper.emitTransportTerminalFailure(message);
      throw err;
    }
  }

  /**
   * Stop the daemon server.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;
    this.automationManager.stop();
    this.providerRuntime.stopAll();
    this.watcherRegistry.stopWatcher('daemon-heartbeat', 'daemon-stopped');
    if (this.replyPoller !== null) {
      clearInterval(this.replyPoller);
      this.replyPoller = null;
    }
    this.pendingSurfaceReplies.clear();
    this.server.stop(true);
    this.server = null;
    this.tlsState = null;
    this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
    this.transportEventsHelper.emitTransportDisconnected('Daemon server stopped', false);
    logger.info('DaemonServer stopped');
  }

  /**
   * Returns true if the server is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private extractAuthToken(req: Request): string {
    return this.controlPlaneHelper.extractAuthToken(req);
  }

  private checkAuth(req: Request): boolean {
    return this.controlPlaneHelper.checkAuth(req);
  }

  private requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    return this.controlPlaneHelper.requireAuthenticatedSession(req);
  }

  private requireAdmin(req: Request): Response | null {
    return this.controlPlaneHelper.requireAdmin(req);
  }

  private async requireRemotePeer(req: Request, scope?: string): Promise<DistributedPeerAuth | Response> {
    return await this.controlPlaneHelper.requireRemotePeer(req, scope);
  }

  private describeAuthenticatedPrincipal(token: string): {
    principalId: string;
    principalKind: 'user' | 'bot' | 'service' | 'token';
    admin: boolean;
    scopes: readonly string[];
  } | null {
    return this.controlPlaneHelper.describeAuthenticatedPrincipal(token);
  }

  private getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    return this.controlPlaneHelper.getGrantedGatewayScopes(includeWrite);
  }

  private validateGatewayInvocation(
    descriptor: import('../control-plane/index.ts').GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly scopes?: readonly string[];
      readonly admin?: boolean;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    return this.controlPlaneHelper.validateGatewayInvocation(descriptor, context);
  }

  private tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    return this.controlPlaneHelper.tryUpgradeControlPlaneWebSocket(req, server);
  }

  private handleControlPlaneWebSocketOpen(ws: {
    data: import('./control-plane.ts').ControlPlaneWebSocketData;
    send(message: string): void;
  }): void {
    this.controlPlaneHelper.handleControlPlaneWebSocketOpen(ws);
  }

  private async handleControlPlaneWebSocketMessage(
    ws: {
      data: import('./control-plane.ts').ControlPlaneWebSocketData;
      send(message: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    await this.controlPlaneHelper.handleControlPlaneWebSocketMessage(ws, message);
  }

  private handleControlPlaneWebSocketClose(ws: {
    data: import('./control-plane.ts').ControlPlaneWebSocketData;
  }): void {
    this.controlPlaneHelper.handleControlPlaneWebSocketClose(ws);
  }

  private async invokeWebSocketControlPlaneCall(input: {
    readonly authToken: string;
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, unknown>;
    readonly body?: unknown;
    readonly context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly admin?: boolean;
      readonly scopes?: readonly string[];
    };
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    return await this.controlPlaneHelper.invokeWebSocketControlPlaneCall(input);
  }

  private async invokeGatewayMethodCall(input: {
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
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    return await this.controlPlaneHelper.invokeGatewayMethodCall(input);
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    return await this.httpRouter.handleRequest(req);
  }

  private async dispatchApiRoutes(req: Request): Promise<Response | null> {
    return await this.httpRouter.dispatchApiRoutes(req);
  }

  private async parseJsonBody(req: Request): Promise<JsonBody | Response> {
    return await this.httpRouter.parseJsonBody(req);
  }

  private async parseOptionalJsonBody(req: Request): Promise<JsonBody | null | Response> {
    return await this.httpRouter.parseOptionalJsonBody(req);
  }

  private parseJsonText(rawBody: string): JsonBody | Response {
    return this.httpRouter.parseJsonText(rawBody);
  }

  private recordApiResponse(
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
    return this.httpRouter.recordApiResponse(req, path, response, clientKind);
  }

  private async handleApprovalAction(
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
  ): Promise<Response> {
    const body = await this.parseOptionalJsonBody(req);
    const payload = body instanceof Response || body === null ? {} as JsonBody : body;
    const actor = this.requireAuthenticatedSession(req)?.username ?? (this.authToken ? 'shared-token' : 'operator');
    const note = typeof payload.note === 'string' ? payload.note : undefined;
    if (action === 'claim') {
      const approval = await this.approvalBroker.claimApproval(approvalId, actor, 'web', note);
      return approval
        ? this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
        : this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
    }
    if (action === 'cancel') {
      const approval = await this.approvalBroker.cancelApproval(approvalId, actor, 'web', note);
      return approval
        ? this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
        : this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
    }
    const approval = await this.approvalBroker.resolveApproval(approvalId, {
      approved: action === 'approve',
      remember: typeof payload.remember === 'boolean' ? payload.remember : false,
      actor,
      actorSurface: 'web',
      note,
    });
    return approval
      ? this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : this.recordApiResponse(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }

  private trySpawnAgent(
    input: Parameters<AgentManager['spawn']>[0],
    logLabel = 'DaemonServer',
    sessionId?: string,
  ): AgentRecord | Response {
    try {
      const spawnInput = Array.isArray((input as { tools?: readonly string[] }).tools)
        ? {
            ...input,
            tools: [...((input as { tools?: readonly string[] }).tools ?? [])],
          }
        : input;
      const record = this.agentManager.spawn(spawnInput);
      this.syncSpawnedAgentTask(record, sessionId);
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`${logLabel}: agent spawn failed`, { error: message });
      return Response.json({ error: `Failed to spawn agent: ${message}` }, { status: 500 });
    }
  }

  private syncSpawnedAgentTask(record: AgentRecord, sessionId?: string): void {
    this.runtimeDispatch?.syncRuntimeTask({
      id: record.id,
      kind: 'agent',
      title: record.task.length > 80 ? `${record.task.slice(0, 77)}...` : record.task,
      description: record.task,
      status: record.status === 'pending' ? 'queued' : 'running',
      owner: record.id,
      cancellable: true,
      childTaskIds: [],
      queuedAt: record.startedAt,
      startedAt: record.status === 'pending' ? undefined : record.startedAt,
      correlationId: sessionId,
    }, 'daemon.server.agent-spawn');
  }

  private syncFinishedAgentTask(record: AgentRecord): void {
    const status = record.status === 'completed'
      ? 'completed'
      : record.status === 'failed'
        ? 'failed'
        : 'cancelled';
    this.runtimeDispatch?.transitionRuntimeTask(record.id, status, {
      endedAt: record.completedAt ?? Date.now(),
      result: record.fullOutput ?? record.streamingContent,
      error: record.error,
    }, 'daemon.server.agent-finish');
  }

  private surfaceDeliveryEnabled(
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ): boolean {
    return isSurfaceDeliveryEnabled(this.configManager, surface);
  }

  private async pollPendingSurfaceReplies(): Promise<void> {
    await this.surfaceDeliveryHelper.pollPendingSurfaceReplies((record) => this.syncFinishedAgentTask(record));
  }

  private trustProxyEnabled(): boolean {
    return this.tlsState?.trustProxy ?? Boolean(this.configManager.get('controlPlane.trustProxy'));
  }

  private signWebhookPayload(body: string, secret: string): string {
    return this.surfaceDeliveryHelper.signWebhookPayload(body, secret);
  }
}
