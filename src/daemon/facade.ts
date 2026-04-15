import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { jsonErrorResponse } from '@pellux/goodvibes-sdk/platform/daemon/http/error-response';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { AgentRecord } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type {
  AutomationDeliveryManager,
  AutomationManager,
} from '@pellux/goodvibes-sdk/platform/automation/index';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
  ChannelSurface,
} from '@pellux/goodvibes-sdk/platform/channels/index';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { PlatformServiceManager } from '@pellux/goodvibes-sdk/platform/daemon/service-manager';
import type { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers/index';
import { type DistributedPeerAuth } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import type { KnowledgeGraphqlService, KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import type { DaemonControlPlaneHelper, ControlPlaneWebSocketData } from '@pellux/goodvibes-sdk/platform/daemon/control-plane';
import type { DaemonSurfaceDeliveryHelper } from '@pellux/goodvibes-sdk/platform/daemon/surface-delivery';
import type { DaemonSurfaceActionHelper } from '@pellux/goodvibes-sdk/platform/daemon/surface-actions';
import type { DaemonTransportEventsHelper } from '@pellux/goodvibes-sdk/platform/daemon/transport-events';
import type { DaemonHttpRouter } from '@pellux/goodvibes-sdk/platform/daemon/http/router';
import { isSurfaceDeliveryEnabled } from './surface-policy.ts';
import {
  configureDaemonSessionContinuation,
  createDaemonFacadeCollaborators,
  resolveDaemonFacadeRuntime,
} from './facade-composition.ts';
import {
  GlobalNetworkTransportInstaller,
  resolveInboundTlsContext,
  type ResolvedInboundTlsContext,
} from '@pellux/goodvibes-sdk/platform/runtime/network/index';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.ts';
import {
  readAutomationReasoningEffort,
  readAutomationWakeMode,
  readExternalContentSource,
  readStringList,
} from '@pellux/goodvibes-sdk/platform/daemon/helpers';
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
  private approvalBrokerUnsubscribe: (() => void) | null = null;

  constructor(private config: DaemonConfig = {}, _configManager?: ConfigManager) {
    const resolved = resolveDaemonFacadeRuntime(config, _configManager);
    this.configManager = resolved.configManager;
    this.runtimeServices = resolved.runtimeServices;
    this.integrationHelpers = resolved.integrationHelpers;
    this.port = resolved.port;
    this.host = resolved.host;
    this.agentManager = resolved.agentManager;
    this.userAuth = resolved.userAuth;
    this.automationManager = resolved.automationManager;
    this.runtimeBus = resolved.runtimeBus;
    this.runtimeStore = resolved.runtimeStore;
    this.runtimeDispatch = resolved.runtimeDispatch;
    this.controlPlaneGateway = resolved.controlPlaneGateway;
    this.gatewayMethods = resolved.gatewayMethods;
    this.sessionBroker = resolved.sessionBroker;
    this.approvalBroker = resolved.approvalBroker;
    this.routeBindings = resolved.routeBindings;
    this.deliveryManager = resolved.deliveryManager;
    this.surfaceRegistry = resolved.surfaceRegistry;
    this.channelPolicy = resolved.channelPolicy;
    this.channelPlugins = resolved.channelPlugins;
    this.watcherRegistry = resolved.watcherRegistry;
    this.platformServiceManager = resolved.platformServiceManager;
    this.distributedRuntime = resolved.distributedRuntime;
    this.voiceService = resolved.voiceService;
    this.webSearchService = resolved.webSearchService;
    this.knowledgeService = resolved.knowledgeService;
    this.knowledgeGraphqlService = resolved.knowledgeGraphqlService;
    this.mediaProviders = resolved.mediaProviders;
    this.multimodalService = resolved.multimodalService;
    this.artifactStore = resolved.artifactStore;
    this.serviceRegistry = resolved.serviceRegistry;
    this.serveFactory = resolved.serveFactory;
    this.githubWebhookSecret = resolved.githubWebhookSecret;

    const collaborators = createDaemonFacadeCollaborators({
      runtime: resolved,
      pendingSurfaceReplies: this.pendingSurfaceReplies,
      authToken: () => this.authToken,
      trustProxyEnabled: () => this.trustProxyEnabled(),
      dispatchApiRoutes: (req) => this.dispatchApiRoutes(req),
      parseJsonBody: (req) => this.parseJsonBody(req),
      requireAuthenticatedSession: (req) => this.requireAuthenticatedSession(req),
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      checkAuth: (req) => this.checkAuth(req),
      extractAuthToken: (req) => this.extractAuthToken(req),
      requireAdmin: (req) => this.requireAdmin(req),
      requireRemotePeer: (req, scope) => this.requireRemotePeer(req, scope),
      describeAuthenticatedPrincipal: (token) => this.describeAuthenticatedPrincipal(token),
      invokeGatewayMethodCall: (input) => this.invokeGatewayMethodCall(input),
      syncSpawnedAgentTask: (record, sessionId) => this.syncSpawnedAgentTask(record, sessionId),
      syncFinishedAgentTask: (record) => this.syncFinishedAgentTask(record),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
      handleApprovalAction: (approvalId, action, req) => this.handleApprovalAction(approvalId, action, req),
      tlsState: () => this.tlsState,
    });
    this.channelReplyPipeline = collaborators.channelReplyPipeline;
    this.controlPlaneHelper = collaborators.controlPlaneHelper;
    this.surfaceDeliveryHelper = collaborators.surfaceDeliveryHelper;
    this.surfaceActionHelper = collaborators.surfaceActionHelper;
    this.transportEventsHelper = collaborators.transportEventsHelper;
    this.httpRouter = collaborators.httpRouter;
    this.providerRuntime = collaborators.providerRuntime;
    this.builtinChannels = collaborators.builtinChannels;

    configureDaemonSessionContinuation({
      sessionBroker: this.sessionBroker,
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
    });

    this.distributedRuntime.attachRuntime({
      sessionBridge: this.sessionBroker,
      approvalBridge: this.approvalBroker,
      automationBridge: this.automationManager,
      eventPublisher: (event, payload) => {
        this.controlPlaneGateway.publishEvent(event, payload);
      },
    });
  }

  listRecentControlPlaneEvents(limit = 100): readonly import('@pellux/goodvibes-sdk/platform/control-plane/gateway').ControlPlaneRecentEvent[] {
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
    if (!this.approvalBrokerUnsubscribe) {
      this.approvalBrokerUnsubscribe = this.approvalBroker.subscribe((approval) => {
        void this.surfaceDeliveryHelper.notifyApprovalUpdate(approval);
      });
    }
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
      const message = summarizeError(err);
      if (this.replyPoller !== null) {
        clearInterval(this.replyPoller);
        this.replyPoller = null;
      }
      this.pendingSurfaceReplies.clear();
      this.automationManager.stop();
      this.providerRuntime.stopAll();
      this.watcherRegistry.stopWatcher('daemon-heartbeat', 'daemon-start-failed');
      this.approvalBrokerUnsubscribe?.();
      this.approvalBrokerUnsubscribe = null;
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
    this.approvalBrokerUnsubscribe?.();
    this.approvalBrokerUnsubscribe = null;
    this.httpRouter.dispose();
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
    descriptor: import('@pellux/goodvibes-sdk/platform/control-plane/index').GatewayMethodDescriptor,
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
    data: import('@pellux/goodvibes-sdk/platform/daemon/control-plane').ControlPlaneWebSocketData;
    send(message: string): void;
  }): void {
    this.controlPlaneHelper.handleControlPlaneWebSocketOpen(ws);
  }

  private async handleControlPlaneWebSocketMessage(
    ws: {
      data: import('@pellux/goodvibes-sdk/platform/daemon/control-plane').ControlPlaneWebSocketData;
      send(message: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    await this.controlPlaneHelper.handleControlPlaneWebSocketMessage(ws, message);
  }

  private handleControlPlaneWebSocketClose(ws: {
    data: import('@pellux/goodvibes-sdk/platform/daemon/control-plane').ControlPlaneWebSocketData;
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
  private trySpawnAgent(input: Parameters<AgentManager['spawn']>[0], logLabel = 'DaemonServer', sessionId?: string): AgentRecord | Response {
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
      const message = summarizeError(err);
      logger.error(`${logLabel}: agent spawn failed`, { error: message });
      return jsonErrorResponse(err, { status: 500, fallbackMessage: 'Failed to spawn agent' });
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
  private surfaceDeliveryEnabled(surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'): boolean {
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
