import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../utils/logger.ts';
import { VERSION } from '../version.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import type { ConfigKey } from '../config/schema.ts';
import { isValidConfigKey } from '../config/schema.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import { UserAuthManager } from '../security/user-auth.ts';
import {
  AutomationDeliveryManager,
  AutomationManager,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationExecutionPolicy,
  type AutomationExternalContentSource,
  type AutomationWakeMode,
} from '../automation/index.ts';
import type { AutomationJob } from '../automation/jobs.ts';
import { SlackIntegration, DiscordIntegration, DiscordInteractionResponseType, DiscordInteractionType, NtfyIntegration } from '../integrations/index.ts';
import { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.ts';
import { GatewayMethodCatalog, type GatewayMethodDescriptor } from '../control-plane/index.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import {
  BuiltinChannelRuntime,
  ChannelReplyPipeline,
  ChannelProviderRuntimeManager,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
  type ChannelAccountLifecycleAction,
  type ChannelConversationKind,
  type ChannelSurface,
} from '../channels/index.ts';
import {
  type GenericWebhookAdapterContext,
  type SurfaceAdapterContext,
  handleDiscordSurfaceWebhook,
  handleGenericWebhookSurface,
  handleGitHubAutomationWebhook,
  handleNtfySurfaceWebhook,
  handleSlackSurfaceWebhook,
} from '../adapters/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { RuntimeEventDomain } from '../runtime/events/index.ts';
import { createDomainDispatch } from '../runtime/store/index.ts';
import {
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportTerminalFailure,
} from '../runtime/emitters/index.ts';
import { getHookDispatcher } from '../hooks/index.ts';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.ts';
import { PlatformServiceManager } from './service-manager.ts';
import { WatcherRegistry } from '../watchers/index.ts';
import { type DistributedPeerAuth, getDistributedRuntimeManager } from '../runtime/remote/index.ts';
import { getMemoryRegistry, MemoryEmbeddingProviderRegistry } from '../state/index.ts';
import { ensureBuiltinVoiceProviders, VoiceService } from '../voice/index.ts';
import { ArtifactStore } from '../artifacts/index.ts';
import { ensureBuiltinMediaProviders, MediaProviderRegistry } from '../media/index.ts';
import { MultimodalService } from '../multimodal/index.ts';
import { WebSearchService } from '../web-search/index.ts';
import { KnowledgeGraphqlService, KnowledgeService } from '../knowledge/index.ts';
import { getProviderRuntimeSnapshot, getProviderUsageSnapshot, listProviderRuntimeSnapshots } from '../providers/runtime-snapshot.ts';
import {
  buildIntegrationHelperReview,
  getIntegrationAutomationSnapshot,
  getIntegrationDeliverySnapshot,
  createIntegrationEventStream,
  getIntegrationApprovalSnapshot,
  getIntegrationHealthSnapshot,
  getIntegrationAccountsSnapshot,
  getIntegrationRemoteSnapshot,
  getIntegrationSessionSnapshot,
  getIntegrationTaskSnapshot,
  getIntegrationSettingsSnapshot,
  getIntegrationLocalAuthSnapshot,
  getIntegrationContinuitySnapshot,
  getIntegrationRouteSnapshot,
  getIntegrationWorktreeSnapshot,
  getIntegrationIntelligenceSnapshot,
  getIntegrationSessionBrokerSnapshot,
  listIntegrationPanels,
  openIntegrationPanel,
  getIntegrationHelpersContextOptional,
} from '../runtime/integration/helpers.ts';
import { dispatchDaemonApiRoutes } from '../control-plane/routes/index.ts';
import {
  createDaemonKnowledgeRouteHandlers,
} from './http/knowledge-routes.ts';
import {
  createDaemonMediaRouteHandlers,
} from './http/media-routes.ts';
import {
  createDaemonRemoteRouteHandlers,
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
} from './http/remote-routes.ts';
import { validatePublicWebhookUrl } from '../utils/url-safety.ts';
import {
  extractForwardedClientIp,
  inspectInboundTls,
  inspectOutboundTls,
  installGlobalNetworkTransport,
  resolveInboundTlsContext,
  type ResolvedInboundTlsContext,
} from '../runtime/network/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DaemonConfig {
  port?: number;
  host?: string;
  agentManager?: AgentManager;
  serveFactory?: typeof Bun.serve;
  /** HMAC-SHA256 secret for verifying GitHub webhook signatures. Falls back to GITHUB_WEBHOOK_SECRET env var. */
  githubWebhookSecret?: string;
  /** Optional pre-configured UserAuthManager (for testing). */
  userAuth?: UserAuthManager;
  /** Optional typed runtime bus for transport lifecycle emission. */
  runtimeBus?: RuntimeEventBus;
}

interface DaemonDangerConfig {
  daemon: boolean;
}

type JsonBody = Record<string, unknown>;

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopeMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith(':*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
}

function missingScopes(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): string[] {
  const granted = grantedScopes ?? [];
  return requiredScopes.filter((required) => !granted.some((entry) => scopeMatches(entry, required)));
}

function resolveGatewayPathTemplate(
  template: string,
  query?: Record<string, unknown>,
  body?: unknown,
): { readonly path: string | null; readonly missing: readonly string[] } {
  const bodyRecord = isJsonRecord(body) ? body : null;
  const missingParams: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_full, rawKey: string) => {
    const key = rawKey.trim();
    const queryValue = query?.[key];
    const bodyValue = bodyRecord?.[key];
    const value = typeof queryValue === 'string' || typeof queryValue === 'number'
      ? queryValue
      : typeof bodyValue === 'string' || typeof bodyValue === 'number'
        ? bodyValue
        : null;
    if (value === null) {
      missingParams.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(String(value));
  });
  return missingParams.length > 0 ? { path: null, missing: missingParams } : { path, missing: [] };
}

function readAutomationWakeMode(value: unknown): AutomationWakeMode | undefined {
  return value === 'now' || value === 'next-heartbeat' ? value : undefined;
}

function readAutomationReasoningEffort(value: unknown): AutomationExecutionPolicy['reasoningEffort'] | undefined {
  return value === 'instant' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

function readExternalContentSource(value: unknown): AutomationExternalContentSource | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim() as AutomationExternalContentSource;
  }
  if (value && typeof value === 'object') {
    return value as AutomationExternalContentSource;
  }
  return undefined;
}

function readChannelLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
  return value === 'inspect'
    || value === 'setup'
    || value === 'retest'
    || value === 'connect'
    || value === 'disconnect'
    || value === 'start'
    || value === 'stop'
    || value === 'login'
    || value === 'logout'
    || value === 'wait_login'
    ? value
    : null;
}

function readChannelConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}

interface PendingSurfaceReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly responseUrl?: string;
  readonly channelId?: string;
  readonly applicationId?: string;
  readonly interactionToken?: string;
  readonly topic?: string;
  readonly callbackUrl?: string;
  readonly callbackSecret?: string;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256';
  readonly callbackCorrelationId?: string;
  readonly targetAddress?: string;
  readonly threadId?: string;
  [key: string]: unknown;
  lastProgressAt?: number;
  lastProgress?: string;
}

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
}

interface ControlPlaneWebSocketData {
  readonly channel: 'control-plane';
  readonly authToken: string;
  readonly principalId: string;
  readonly principalKind: 'user' | 'bot' | 'service' | 'token';
  readonly admin: boolean;
  readonly scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  readonly clientKind:
    | 'tui'
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
    | 'daemon';
  readonly remoteAddress?: string;
  clientId?: string;
}

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
  private configManager: ConfigManager;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private githubWebhookSecret: string | null;
  private automationManager: AutomationManager;
  private runtimeBus: RuntimeEventBus | null;
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
  private readonly distributedRuntime = getDistributedRuntimeManager();
  private readonly voiceService = VoiceService.getActive();
  private readonly webSearchService = WebSearchService.getActive();
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  private readonly mediaProviders = MediaProviderRegistry.getActive();
  private readonly multimodalService: MultimodalService;
  private readonly artifactStore: ArtifactStore;
  private readonly serviceRegistry: ServiceRegistry;
  private readonly serveFactory: typeof Bun.serve;
  private readonly pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  private replyPoller: ReturnType<typeof setInterval> | null = null;
  private tlsState: ResolvedInboundTlsContext | null = null;

  constructor(private config: DaemonConfig = {}, _configManager?: ConfigManager) {
    this.configManager = _configManager ?? new ConfigManager();
    this.port = config.port ?? Number(this.configManager.get('controlPlane.port') ?? 3421);
    this.host = config.host ?? String(this.configManager.get('controlPlane.host') ?? '127.0.0.1');
    this.agentManager = config.agentManager ?? AgentManager.getInstance();
    this.userAuth = config.userAuth ?? new UserAuthManager();
    this.serveFactory = config.serveFactory ?? Bun.serve;
    this.serviceRegistry = new ServiceRegistry();
    this.artifactStore = ArtifactStore.getActive({ configManager: this.configManager });
    this.knowledgeService = KnowledgeService.getActive({ configManager: this.configManager });
    this.knowledgeGraphqlService = new KnowledgeGraphqlService(this.knowledgeService);
    this.multimodalService = new MultimodalService(this.artifactStore, this.mediaProviders, this.voiceService, this.knowledgeService);
    this.platformServiceManager = new PlatformServiceManager(this.configManager);
    // Webhook secrets follow 12-factor app conventions (https://12factor.net/config):
    // prefer explicit config object values (e.g. from a vault-injected object) and
    // fall back to environment variables so the binary works in any deployment
    // without code changes. Secrets are never logged or exposed via the API.
    this.githubWebhookSecret =
      config.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? null;
    this.automationManager = AutomationManager.getInstance();
    this.runtimeBus = config.runtimeBus ?? null;
    this.gatewayMethods = GatewayMethodCatalog.getActive();
    this.sessionBroker = SharedSessionBroker.getInstance();
    this.approvalBroker = ApprovalBroker.getInstance();
    const integrationContext = getIntegrationHelpersContextOptional();
    this.knowledgeService.attachRuntimeBus(this.runtimeBus ?? integrationContext?.runtimeBus ?? null);
    this.routeBindings = RouteBindingManager.getInstance();
    this.routeBindings.attachRuntime({
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? undefined,
      runtimeStore: integrationContext?.runtimeStore ?? undefined,
    });
    this.surfaceRegistry = SurfaceRegistry.getInstance();
    this.channelPolicy = ChannelPolicyManager.getInstance();
    this.channelPlugins = new ChannelPluginRegistry();
    this.channelReplyPipeline = new ChannelReplyPipeline({
      channelPlugins: this.channelPlugins,
      routeBindings: this.routeBindings,
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? null,
    });
    if (integrationContext?.runtimeStore) {
      this.surfaceRegistry.attachRuntime(integrationContext.runtimeStore);
    }
    this.surfaceRegistry.attachPluginRegistry(this.channelPlugins);
    this.watcherRegistry = WatcherRegistry.getInstance();
    this.watcherRegistry.attachRuntime({
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? undefined,
      runtimeStore: integrationContext?.runtimeStore ?? undefined,
    });
    this.deliveryManager = new AutomationDeliveryManager({
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? undefined,
      runtimeStore: integrationContext?.runtimeStore ?? undefined,
      routeBindings: this.routeBindings,
      serviceRegistry: this.serviceRegistry,
      configManager: this.configManager,
    });
    this.automationManager.attachRuntime({
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? undefined,
      runtimeStore: integrationContext?.runtimeStore ?? undefined,
      deliveryManager: this.deliveryManager,
    });
    this.controlPlaneGateway = new ControlPlaneGateway({
      runtimeBus: this.runtimeBus ?? integrationContext?.runtimeBus ?? null,
      runtimeStore: integrationContext?.runtimeStore ?? null,
      server: {
        enabled: false,
        host: this.host,
        port: this.port,
        streamingMode: (this.configManager.get('controlPlane.streamMode') as import('../control-plane/index.ts').ControlPlaneStreamingMode | undefined) ?? 'sse',
      },
    });
    this.approvalBroker.subscribe((approval) => {
      void this.notifyApprovalUpdate(approval);
    });
    this.distributedRuntime.attachRuntime({
      sessionBridge: this.sessionBroker,
      approvalBridge: this.approvalBroker,
      automationBridge: this.automationManager,
    });
    this.providerRuntime = new ChannelProviderRuntimeManager({
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      buildSurfaceAdapterContext: () => this.buildSurfaceAdapterContext(),
    });
    ensureBuiltinVoiceProviders();
    ensureBuiltinMediaProviders(this.mediaProviders);
    this.builtinChannels = new BuiltinChannelRuntime({
      configManager: this.configManager,
      serviceRegistry: this.serviceRegistry,
      routeBindings: this.routeBindings,
      channelPlugins: this.channelPlugins,
      providerRuntime: this.providerRuntime,
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      buildSurfaceAdapterContext: () => this.buildSurfaceAdapterContext(),
      buildGenericWebhookAdapterContext: () => this.buildGenericWebhookAdapterContext(),
      deliverSurfaceProgress: (pending, progress) => this.deliverSurfaceProgress(pending as PendingSurfaceReply, progress),
      deliverSlackAgentReply: (pending, message) => this.deliverSlackAgentReply(pending as PendingSurfaceReply, message),
      deliverDiscordAgentReply: (pending, message) => this.deliverDiscordAgentReply(pending as PendingSurfaceReply, message),
      deliverNtfyAgentReply: (pending, message) => this.deliverNtfyAgentReply(pending as PendingSurfaceReply, message),
      deliverWebhookAgentReply: (pending, message) => this.deliverWebhookAgentReply(pending as PendingSurfaceReply, message),
      deliverSlackApprovalUpdate: (approval, binding) => this.deliverSlackApprovalUpdate(approval, binding),
      deliverDiscordApprovalUpdate: (approval, binding) => this.deliverDiscordApprovalUpdate(approval, binding),
      deliverNtfyApprovalUpdate: (approval, binding) => this.deliverNtfyApprovalUpdate(approval, binding),
      deliverWebhookApprovalUpdate: (approval, binding) => this.deliverWebhookApprovalUpdate(approval, binding),
    });
    this.builtinChannels.registerPlugins();
  }

  private buildSurfaceAdapterContext(): SurfaceAdapterContext {
    return {
      serviceRegistry: this.serviceRegistry,
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      parseSurfaceControlCommand: (text) => this.parseSurfaceControlCommand(text),
      performSurfaceControlCommand: (command) => this.performSurfaceControlCommand(command),
      performInteractiveSurfaceAction: (actionId, surface, request) => this.performInteractiveSurfaceAction(actionId, surface, request),
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.queueSurfaceReplyFromBinding(binding, input),
    };
  }

  private buildGenericWebhookAdapterContext(): GenericWebhookAdapterContext {
    return {
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
      queueWebhookReply: (input) => this.queueWebhookReply(input),
    };
  }

  private async authorizeSurfaceIngress(input: import('../channels/index.ts').ChannelIngressPolicyInput): Promise<import('../channels/index.ts').ChannelPolicyDecision> {
    return this.channelPolicy.evaluateIngress(input);
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

    installGlobalNetworkTransport(this.configManager);
    const integrationContext = getIntegrationHelpersContextOptional();
    if (integrationContext) {
      this.routeBindings.attachRuntime({
        runtimeBus: this.runtimeBus ?? integrationContext.runtimeBus,
        runtimeStore: integrationContext.runtimeStore,
      });
      this.surfaceRegistry.attachRuntime(integrationContext.runtimeStore);
      this.deliveryManager.attachRuntime({
        runtimeBus: this.runtimeBus ?? integrationContext.runtimeBus,
        runtimeStore: integrationContext.runtimeStore,
      });
      this.automationManager.attachRuntime({
        runtimeBus: this.runtimeBus ?? integrationContext.runtimeBus,
        runtimeStore: integrationContext.runtimeStore,
        deliveryManager: this.deliveryManager,
      });
      this.controlPlaneGateway.attachRuntime({
        runtimeBus: this.runtimeBus ?? integrationContext.runtimeBus,
        runtimeStore: integrationContext.runtimeStore,
      });
    }

    const self = this;
    this.emitTransportInitializing();
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
      this.emitTransportConnected();
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
      this.emitTransportTerminalFailure(message);
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
    this.emitTransportDisconnected('Daemon server stopped', false);
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
    const bearer = req.headers.get('authorization')?.replace('Bearer ', '').trim();
    if (bearer) return bearer;
    const url = new URL(req.url);
    const queryToken = url.searchParams.get('token') ?? url.searchParams.get('access_token');
    return queryToken?.trim() ?? '';
  }

  private checkAuth(req: Request): boolean {
    const bearer = this.extractAuthToken(req);

    if (this.authToken) {
      if (bearer.length !== this.authToken.length) return false;
      return timingSafeEqual(Buffer.from(bearer), Buffer.from(this.authToken));
    }

    if (!bearer) return false;
    return this.userAuth.validateSession(bearer) !== null;
  }

  private requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    const bearer = this.extractAuthToken(req);
    if (!bearer || this.authToken) return null;
    const session = this.userAuth.validateSession(bearer);
    if (!session) return null;
    const user = this.userAuth.getUser(session.username);
    if (!user) return null;
    return user;
  }

  private requireAdmin(req: Request): Response | null {
    if (this.authToken) return null;
    const user = this.requireAuthenticatedSession(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!user.roles.includes('admin')) {
      return Response.json({ error: 'Admin role required' }, { status: 403 });
    }
    return null;
  }

  private async requireRemotePeer(req: Request, scope?: string): Promise<DistributedPeerAuth | Response> {
    const token = this.extractAuthToken(req);
    const auth = await this.distributedRuntime.authenticatePeerToken(
      token,
      extractForwardedClientIp(req, this.trustProxyEnabled()),
    );
    if (!auth) {
      return Response.json({ error: 'Unauthorized remote peer' }, { status: 401 });
    }
    if (scope && !auth.token.scopes.includes(scope)) {
      return Response.json({ error: `Remote peer token missing required scope: ${scope}` }, { status: 403 });
    }
    return auth;
  }

  private describeAuthenticatedPrincipal(token: string): {
    principalId: string;
    principalKind: 'user' | 'bot' | 'service' | 'token';
    admin: boolean;
    scopes: readonly string[];
  } | null {
    if (this.authToken) {
      if (token.length !== this.authToken.length) return null;
      if (!timingSafeEqual(Buffer.from(token), Buffer.from(this.authToken))) return null;
      return {
        principalId: 'shared-token',
        principalKind: 'token',
        admin: true,
        scopes: this.getGrantedGatewayScopes(true),
      };
    }
    if (!token) return null;
    const session = this.userAuth.validateSession(token);
    if (!session) return null;
    const user = this.userAuth.getUser(session.username);
    if (!user) return null;
    const admin = user.roles.includes('admin');
    return {
      principalId: user.username,
      principalKind: 'user',
      admin,
      scopes: this.getGrantedGatewayScopes(admin),
    };
  }

  private getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    const scopes = new Set(this.gatewayMethods.getAllScopes({ includeWrite }));
    scopes.add('read:events');
    scopes.add('read:control-plane');
    if (includeWrite) scopes.add('write:control-plane');
    return [...scopes].sort();
  }

  private validateGatewayInvocation(
    descriptor: GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer';
      readonly scopes?: readonly string[];
      readonly admin?: boolean;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    if (descriptor.invokable === false) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Gateway method is cataloged but not invokable through method dispatch: ${descriptor.id}`,
        },
      };
    }
    if (descriptor.access === 'admin' && !context?.admin) {
      return {
        status: 403,
        ok: false,
        body: {
          error: `Gateway method requires admin access: ${descriptor.id}`,
        },
      };
    }
    if (descriptor.access === 'remote-peer' && context?.principalKind !== 'remote-peer') {
      return {
        status: 403,
        ok: false,
        body: {
          error: `Gateway method requires a remote-peer principal: ${descriptor.id}`,
        },
      };
    }
    const missing = missingScopes(context?.scopes, descriptor.scopes);
    if (missing.length > 0) {
      return {
        status: 403,
        ok: false,
        body: {
          error: `Missing required scope${missing.length === 1 ? '' : 's'} for ${descriptor.id}: ${missing.join(', ')}`,
          requiredScopes: [...descriptor.scopes],
          grantedScopes: [...(context?.scopes ?? [])],
          missingScopes: missing,
        },
      };
    }
    return null;
  }

  private tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    const url = new URL(req.url);
    if (url.pathname !== '/api/control-plane/ws' || req.method !== 'GET') {
      return null;
    }
    const token = this.extractAuthToken(req);
    const principal = this.describeAuthenticatedPrincipal(token);
    if (!principal) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rawDomains = url.searchParams.get('domains');
    const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
    const requestedKind = url.searchParams.get('clientKind');
    const clientKind = requestedKind === 'tui'
      || requestedKind === 'web'
      || requestedKind === 'slack'
      || requestedKind === 'discord'
      || requestedKind === 'ntfy'
      || requestedKind === 'daemon'
      || requestedKind === 'webhook'
      ? requestedKind
      : 'web';
    const upgraded = server.upgrade(req, {
      data: {
        channel: 'control-plane',
        authToken: token,
        principalId: principal.principalId,
        principalKind: principal.principalKind,
        scopes: principal.scopes,
        admin: principal.admin,
        domains,
        clientKind,
        remoteAddress: extractForwardedClientIp(req, this.trustProxyEnabled()),
      } satisfies ControlPlaneWebSocketData,
    });
    return upgraded ? 'upgraded' : Response.json({ error: 'WebSocket upgrade failed' }, { status: 400 });
  }

  private handleControlPlaneWebSocketOpen(ws: {
    data: ControlPlaneWebSocketData;
    send(message: string): void;
  }): void {
    const connection = this.controlPlaneGateway.openWebSocketClient({
      clientKind: ws.data.clientKind,
      transport: 'ws',
      domains: ws.data.domains,
      principalId: ws.data.principalId,
      principalKind: ws.data.principalKind,
      scopes: ws.data.scopes,
      remoteAddress: ws.data.remoteAddress,
    }, (event, payload) => {
      ws.send(JSON.stringify({
        type: 'event',
        event,
        payload,
      }));
    });
    ws.data.clientId = connection.clientId;
  }

  private async handleControlPlaneWebSocketMessage(
    ws: {
      data: ControlPlaneWebSocketData;
      send(message: string): void;
    },
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    const clientId = ws.data.clientId;
    if (!clientId) return;
    const text = typeof message === 'string'
      ? message
      : message instanceof Uint8Array
        ? new TextDecoder().decode(message)
        : message instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(message))
          : Buffer.from(message).toString('utf8');
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON frame' }));
      return;
    }

    this.controlPlaneGateway.touchWebSocketClient(clientId, {
      lastFrameType: typeof frame.type === 'string' ? frame.type : 'unknown',
    });

    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }

    if (frame.type === 'auth') {
      const token = typeof frame.token === 'string' ? frame.token : ws.data.authToken;
      const principal = this.describeAuthenticatedPrincipal(token);
      if (!principal) {
        ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }));
        return;
      }
        this.controlPlaneGateway.authenticateClient(clientId, {
          principalId: principal.principalId,
          principalKind: principal.principalKind,
          scopes: principal.scopes,
          ...(typeof frame.label === 'string' ? { label: frame.label } : {}),
          ...(Array.isArray(frame.capabilities)
          ? { capabilities: frame.capabilities.filter((value): value is string => typeof value === 'string') }
          : {}),
      });
      if (Array.isArray(frame.domains)) {
        this.controlPlaneGateway.subscribeWebSocketClient(
          clientId,
          frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[],
        );
      }
      ws.send(JSON.stringify({ type: 'auth', ok: true, clientId, principalId: principal.principalId }));
      return;
    }

    if (frame.type === 'subscribe') {
      const domains = Array.isArray(frame.domains)
        ? frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[]
        : [];
      this.controlPlaneGateway.subscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'subscribed', clientId, domains }));
      return;
    }

    if (frame.type === 'unsubscribe') {
      const domains = Array.isArray(frame.domains)
        ? frame.domains.filter((value): value is RuntimeEventDomain => typeof value === 'string') as RuntimeEventDomain[]
        : undefined;
      this.controlPlaneGateway.unsubscribeWebSocketClient(clientId, domains);
      ws.send(JSON.stringify({ type: 'unsubscribed', clientId, domains: domains ?? [] }));
      return;
    }

    if (frame.type === 'call') {
      const id = typeof frame.id === 'string' ? frame.id : `call-${Date.now()}`;
      const methodId = typeof frame.methodId === 'string' ? frame.methodId : undefined;
      const response = methodId
        ? await this.invokeGatewayMethodCall({
            authToken: ws.data.authToken,
            methodId,
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalId: ws.data.principalId,
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
              clientKind: ws.data.clientKind,
            },
          })
        : await this.invokeWebSocketControlPlaneCall({
            authToken: ws.data.authToken,
            method: typeof frame.method === 'string' ? frame.method.toUpperCase() : 'GET',
            path: typeof frame.path === 'string' ? frame.path : '/api/control-plane',
            query: typeof frame.query === 'object' && frame.query !== null ? frame.query as Record<string, unknown> : undefined,
            body: frame.body,
            context: {
              principalKind: ws.data.principalKind,
              admin: ws.data.admin,
              scopes: ws.data.scopes,
            },
          });
      ws.send(JSON.stringify({
        type: 'response',
        id,
        ok: response.ok,
        status: response.status,
        body: response.body,
      }));
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'Unsupported frame type' }));
  }

  private handleControlPlaneWebSocketClose(ws: {
    data: ControlPlaneWebSocketData;
  }): void {
    if (!ws.data.clientId) return;
    this.controlPlaneGateway.closeWebSocketClient(ws.data.clientId, 'socket-closed');
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
    const matchedDescriptor = this.gatewayMethods.findByHttpBinding(input.method, input.path);
    if (matchedDescriptor) {
      const denied = this.validateGatewayInvocation(matchedDescriptor, input.context);
      if (denied) return denied;
    }
    const url = new URL(`http://${this.host}:${this.port}${input.path.startsWith('/') ? input.path : `/${input.path}`}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const request = new Request(url.toString(), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.authToken}`,
        ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
    const response = await this.dispatchApiRoutes(request) ?? Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await response.text();
    let body: unknown = raw;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else {
      body = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      body,
    };
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
    const descriptor = this.gatewayMethods.get(input.methodId);
    if (!descriptor) {
      return { status: 404, ok: false, body: { error: `Unknown gateway method: ${input.methodId}` } };
    }
    const denied = this.validateGatewayInvocation(descriptor, input.context);
    if (denied) return denied;
    if (this.gatewayMethods.hasHandler(input.methodId)) {
      try {
        const body = await this.gatewayMethods.invoke(input.methodId, {
          body: input.body,
          query: input.query,
          context: {
            authToken: input.authToken,
            principalId: input.context?.principalId,
            principalKind: input.context?.principalKind,
            admin: input.context?.admin,
            scopes: input.context?.scopes,
            clientKind: input.context?.clientKind,
          },
        });
        return { status: 200, ok: true, body };
      } catch (error) {
        return {
          status: 500,
          ok: false,
          body: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }
    if (!descriptor.http) {
      return { status: 501, ok: false, body: { error: `Gateway method is not invokable: ${input.methodId}` } };
    }
    const resolvedPath = resolveGatewayPathTemplate(descriptor.http.path, input.query, input.body);
    if (!resolvedPath.path) {
      return {
        status: 400,
        ok: false,
        body: {
          error: `Missing path parameter${resolvedPath.missing.length === 1 ? '' : 's'} for ${input.methodId}: ${resolvedPath.missing.join(', ')}`,
          missing: [...resolvedPath.missing],
        },
      };
    }
    return this.invokeWebSocketControlPlaneCall({
      authToken: input.authToken,
      method: descriptor.http.method,
      path: resolvedPath.path,
      query: input.query,
      body: descriptor.http.method === 'GET' || descriptor.http.method === 'DELETE' ? undefined : input.body,
      context: {
        principalKind: input.context?.principalKind,
        admin: input.context?.admin,
        scopes: input.context?.scopes,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }

    if (url.pathname === '/api/remote/pair/request' && req.method === 'POST') {
      return handleRemotePairRequest({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/pair/verify' && req.method === 'POST') {
      return handleRemotePairVerify({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/heartbeat' && req.method === 'POST') {
      return handleRemotePeerHeartbeat({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.requireRemotePeer(request, scope),
        distributedRuntime: this.distributedRuntime,
      }, req);
    }
    if (url.pathname === '/api/remote/work/pull' && req.method === 'POST') {
      return handleRemotePeerWorkPull({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.requireRemotePeer(request, scope),
        distributedRuntime: this.distributedRuntime,
      }, req);
    }
    const remoteWorkCompleteMatch = url.pathname.match(/^\/api\/remote\/work\/([^/]+)\/complete$/);
    if (remoteWorkCompleteMatch && req.method === 'POST') {
      return handleRemotePeerWorkComplete({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.requireRemotePeer(request, scope),
        distributedRuntime: this.distributedRuntime,
      }, remoteWorkCompleteMatch[1], req);
    }

    if (url.pathname === '/webhook/github' && req.method === 'POST') {
      return this.handleGitHubWebhook(req);
    }
    if (url.pathname.startsWith('/webhook/')) {
      const pluginResponse = await this.channelPlugins.handleInbound(url.pathname, req);
      if (pluginResponse) return pluginResponse;
    }

    if (url.pathname === '/api/control-plane/web' && req.method === 'GET' && !this.authToken) {
      if (!this.checkAuth(req)) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return this.controlPlaneGateway.renderWebUi(this.extractAuthToken(req));
    }

    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiResponse = await this.dispatchApiRoutes(req);
    if (apiResponse) return apiResponse;

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private async dispatchApiRoutes(req: Request): Promise<Response | null> {
    return dispatchDaemonApiRoutes(req, {
      getStatus: () => Response.json({
        status: 'running',
        version: VERSION,
        network: {
          controlPlane: inspectInboundTls(this.configManager, 'controlPlane'),
          httpListener: inspectInboundTls(this.configManager, 'httpListener'),
          outbound: inspectOutboundTls(this.configManager),
        },
      }),
      getReview: () => Response.json(buildIntegrationHelperReview()),
      getIntegrationSession: () => Response.json(getIntegrationSessionSnapshot()),
      getIntegrationTasks: () => Response.json(getIntegrationTaskSnapshot()),
      getIntegrationAutomation: () => Response.json(getIntegrationAutomationSnapshot()),
      getIntegrationSessions: () => Response.json(getIntegrationSessionBrokerSnapshot()),
      createSharedSession: (request) => this.handleCreateSharedSession(request),
      getControlPlaneSnapshot: () => Response.json(this.controlPlaneGateway.getSnapshot()),
      getControlPlaneWeb: () => this.controlPlaneGateway.renderWebUi(this.extractAuthToken(req)),
      getControlPlaneRecentEvents: (limit) => Response.json({ events: this.controlPlaneGateway.listRecentEvents(limit) }),
      getControlPlaneMessages: () => Response.json({ messages: this.controlPlaneGateway.listSurfaceMessages() }),
      getControlPlaneClients: () => Response.json({ clients: this.controlPlaneGateway.listClients() }),
      getGatewayMethods: (url) => {
        const category = url.searchParams.get('category') ?? undefined;
        const source = url.searchParams.get('source');
        return Response.json({
          methods: this.gatewayMethods.list({
            ...(category ? { category } : {}),
            ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
          }),
        });
      },
      getGatewayEvents: (url) => {
        const category = url.searchParams.get('category') ?? undefined;
        const source = url.searchParams.get('source');
        const domain = url.searchParams.get('domain') ?? undefined;
        return Response.json({
          events: this.gatewayMethods.listEvents({
            ...(category ? { category } : {}),
            ...(source === 'builtin' || source === 'plugin' ? { source } : {}),
            ...(domain ? { domain: domain as RuntimeEventDomain } : {}),
          }),
        });
      },
      getGatewayMethod: (methodId) => {
        const method = this.gatewayMethods.get(methodId);
        return method
          ? Response.json({ method })
          : Response.json({ error: 'Unknown gateway method' }, { status: 404 });
      },
      invokeGatewayMethod: async (methodId, request) => {
        const descriptor = this.gatewayMethods.get(methodId);
        if (!descriptor) return Response.json({ error: 'Unknown gateway method' }, { status: 404 });
        if (descriptor.dangerous || descriptor.access === 'admin') {
          const admin = this.requireAdmin(request);
          if (admin) return admin;
        }
        const principal = this.describeAuthenticatedPrincipal(this.extractAuthToken(request));
        const body = await this.parseOptionalJsonBody(request);
        if (body instanceof Response) return body;
        const payload = body ?? {};
        const response = await this.invokeGatewayMethodCall({
          authToken: this.extractAuthToken(request),
          methodId,
          query: typeof payload.query === 'object' && payload.query !== null ? payload.query as Record<string, unknown> : undefined,
          body: Object.hasOwn(payload, 'body') ? payload.body : payload,
          context: {
            principalId: principal?.principalId,
            principalKind: principal?.principalKind,
            admin: principal?.admin,
            scopes: principal?.scopes,
            clientKind: 'web',
          },
        });
        return Response.json(response.body, { status: response.status });
      },
      createControlPlaneEventStream: (request) => {
        const url = new URL(request.url);
        const rawDomains = url.searchParams.get('domains');
        const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
        const principal = this.describeAuthenticatedPrincipal(this.extractAuthToken(request));
        return this.controlPlaneGateway.createEventStream(request, {
          clientKind: 'web',
          transport: 'sse',
          domains,
          principalId: principal?.principalId ?? (this.authToken ? 'shared-token' : this.requireAuthenticatedSession(request)?.username ?? 'session-user'),
          principalKind: principal?.principalKind ?? (this.authToken ? 'token' : 'user'),
          scopes: principal?.scopes ?? ['read:events', 'read:control-plane'],
        });
      },
      getAutomationJobs: () => this.handleGetSchedules(),
      postAutomationJob: (request) => this.handlePostSchedule(request),
      getAutomationRuns: () => Response.json({ runs: this.automationManager.listRuns() }),
      getAutomationRun: (runId) => this.handleGetAutomationRun(runId),
      getAutomationHeartbeat: () => Response.json({ pending: this.automationManager.listHeartbeatWakes() }),
      postAutomationHeartbeat: async (request) => {
        const body = await this.parseOptionalJsonBody(request);
        if (body instanceof Response) return body;
        const result = await this.automationManager.triggerHeartbeat({
          source: body && typeof body.source === 'string' ? body.source : 'api',
        });
        return Response.json(result);
      },
      automationRunAction: (runId, action, request) => this.handleAutomationRunAction(runId, action, request),
      patchAutomationJob: (jobId, request) => this.handlePatchSchedule(jobId, request),
      deleteAutomationJob: async (jobId) => this.handleDeleteSchedule(jobId),
      setAutomationJobEnabled: (jobId, enabled) => this.handleSetScheduleEnabled(jobId, enabled),
      runAutomationJobNow: (jobId) => this.handleRunScheduleNow(jobId),
      getDeliveries: () => Response.json(getIntegrationDeliverySnapshot()),
      getDelivery: (deliveryId) => this.handleGetDelivery(deliveryId),
      getRoutesSnapshot: () => Response.json(getIntegrationRouteSnapshot()),
      getSurfaces: () => Response.json({ surfaces: this.surfaceRegistry.list() }),
      getChannelAccounts: () => this.channelPlugins.listAccounts().then((accounts) => Response.json({ accounts })),
      getChannelSurfaceAccounts: (surface) => this.channelPlugins
        .listAccounts(surface as import('../channels/index.ts').ChannelSurface)
        .then((accounts) => Response.json({ accounts })),
      getChannelAccount: async (surface, accountId) => {
        const account = await this.channelPlugins.getAccount(
          surface as import('../channels/index.ts').ChannelSurface,
          accountId,
        );
        return account
          ? Response.json(account)
          : Response.json({ error: 'Unknown channel account' }, { status: 404 });
      },
      getChannelSetupSchema: async (surface, url) => {
        const schema = await this.channelPlugins.getSetupSchema(
          surface as import('../channels/index.ts').ChannelSurface,
          url.searchParams.get('accountId') ?? undefined,
        );
        return schema
          ? Response.json(schema)
          : Response.json({ error: 'Unknown channel setup schema' }, { status: 404 });
      },
      getChannelDoctor: async (surface, url) => {
        const report = await this.channelPlugins.doctor(
          surface as import('../channels/index.ts').ChannelSurface,
          url.searchParams.get('accountId') ?? undefined,
        );
        return report
          ? Response.json(report)
          : Response.json({ error: 'Unknown channel doctor surface' }, { status: 404 });
      },
      getChannelRepairActions: async (surface, url) => Response.json({
        actions: await this.channelPlugins.listRepairActions(
          surface as import('../channels/index.ts').ChannelSurface,
          url.searchParams.get('accountId') ?? undefined,
        ),
      }),
      getChannelLifecycle: async (surface, url) => {
        const state = await this.channelPlugins.getLifecycleState(
          surface as import('../channels/index.ts').ChannelSurface,
          url.searchParams.get('accountId') ?? undefined,
        );
        return state
          ? Response.json(state)
          : Response.json({ error: 'Unknown channel lifecycle surface' }, { status: 404 });
      },
      postChannelLifecycleMigrate: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseOptionalJsonBody(request);
        if (body instanceof Response) return body;
        const state = await this.channelPlugins.migrateLifecycle(
          surface as import('../channels/index.ts').ChannelSurface,
          typeof body?.accountId === 'string' ? body.accountId : undefined,
          body ?? undefined,
        );
        return state
          ? Response.json(state)
          : Response.json({ error: 'Unknown channel lifecycle surface' }, { status: 404 });
      },
      postChannelAccountAction: async (surface, accountId, action, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        const input = body instanceof Response
          ? undefined
          : body;
        if (body instanceof Response && request.headers.get('content-length') && request.headers.get('content-length') !== '0') {
          return body;
        }
        const lifecycleAction = readChannelLifecycleAction(action);
        if (!lifecycleAction) {
          return Response.json({ error: 'Unknown channel account action' }, { status: 400 });
        }
        const result = await this.channelPlugins.runAccountAction(
          surface as import('../channels/index.ts').ChannelSurface,
          lifecycleAction,
          accountId ?? (typeof input?.accountId === 'string' ? input.accountId : undefined),
          input,
        );
        return result !== null
          ? Response.json({ surface, accountId, action: lifecycleAction, result })
          : Response.json({ error: 'Unknown channel account action' }, { status: 404 });
      },
      getChannelCapabilities: () => this.channelPlugins.listCapabilities().then((capabilities) => Response.json({ capabilities })),
      getChannelSurfaceCapabilities: (surface) => this.channelPlugins
        .listCapabilities(surface as import('../channels/index.ts').ChannelSurface)
        .then((capabilities) => Response.json({ capabilities })),
      getChannelTools: () => this.channelPlugins.listTools().then((tools) => Response.json({ tools })),
      getChannelSurfaceTools: (surface) => this.channelPlugins
        .listTools(surface as import('../channels/index.ts').ChannelSurface)
        .then((tools) => Response.json({ tools })),
      getChannelAgentTools: () => Response.json({ tools: this.channelPlugins.listAgentTools().map((tool) => tool.definition) }),
      getChannelSurfaceAgentTools: (surface) => Response.json({
        tools: this.channelPlugins
          .listAgentTools(surface as import('../channels/index.ts').ChannelSurface)
          .map((tool) => tool.definition),
      }),
      postChannelTool: async (surface, toolId, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        const input = body instanceof Response
          ? undefined
          : body;
        if (body instanceof Response && request.headers.get('content-length') && request.headers.get('content-length') !== '0') {
          return body;
        }
        const result = await this.channelPlugins.runTool(
          surface as import('../channels/index.ts').ChannelSurface,
          toolId,
          input,
        );
        return result !== null
          ? Response.json({ toolId, surface, result })
          : Response.json({ error: 'Unknown channel tool' }, { status: 404 });
      },
      getChannelActions: () => this.channelPlugins.listOperatorActions().then((actions) => Response.json({ actions })),
      getChannelSurfaceActions: (surface) => this.channelPlugins
        .listOperatorActions(surface as import('../channels/index.ts').ChannelSurface)
        .then((actions) => Response.json({ actions })),
      postChannelAction: async (surface, actionId, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        const input = body instanceof Response
          ? undefined
          : body;
        if (body instanceof Response && request.headers.get('content-length') && request.headers.get('content-length') !== '0') {
          return body;
        }
        const result = await this.channelPlugins.runOperatorAction(
          surface as import('../channels/index.ts').ChannelSurface,
          actionId,
          input,
        );
        return result !== null
          ? Response.json({ actionId, surface, result })
          : Response.json({ error: 'Unknown channel action' }, { status: 404 });
      },
      postChannelResolveTarget: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const targetInput = typeof body.target === 'string'
          ? body.target
          : typeof body.input === 'string'
            ? body.input
            : typeof body.query === 'string'
              ? body.query
              : '';
        if (!targetInput.trim()) {
          return Response.json({ error: 'Target resolution requires target, input, or query.' }, { status: 400 });
        }
        const preferredKind = readChannelConversationKind(body.preferredKind);
        const target = await this.channelPlugins.resolveTarget(
          surface as import('../channels/index.ts').ChannelSurface,
          {
            input: targetInput,
            ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
            ...(preferredKind ? { preferredKind } : {}),
            ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
            ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
            ...(typeof body.createIfMissing === 'boolean' ? { createIfMissing: body.createIfMissing } : {}),
            ...(typeof body.live === 'boolean' ? { live: body.live } : {}),
            ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
          },
        );
        return target
          ? Response.json({ surface, target })
          : Response.json({ error: 'Unable to resolve channel target' }, { status: 404 });
      },
      postChannelAuthorize: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const target = typeof body.target === 'string' && body.target.trim()
          ? await this.channelPlugins.resolveTarget(
              surface as import('../channels/index.ts').ChannelSurface,
              {
                input: body.target,
                ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
                createIfMissing: true,
              },
            )
          : null;
        const result = await this.channelPlugins.authorizeActorAction(
          surface as import('../channels/index.ts').ChannelSurface,
          {
            actionId: typeof body.actionId === 'string' ? body.actionId : 'unknown',
            ...(typeof body.actorId === 'string' ? { actorId: body.actorId } : {}),
            ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
            ...(target ? { target } : {}),
            ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
          },
        );
        return result
          ? Response.json({ surface, result })
          : Response.json({ error: 'Unable to authorize channel action' }, { status: 404 });
      },
      postChannelAllowlistResolve: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const result = await this.channelPlugins.resolveAllowlist(
          surface as import('../channels/index.ts').ChannelSurface,
          {
            ...(Array.isArray(body.add) ? { add: body.add.filter((value): value is string => typeof value === 'string') } : {}),
            ...(Array.isArray(body.remove) ? { remove: body.remove.filter((value): value is string => typeof value === 'string') } : {}),
            ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
            ...(typeof body.channelId === 'string' ? { channelId: body.channelId } : {}),
            ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
            ...(body.kind === 'user' || body.kind === 'channel' || body.kind === 'group' ? { kind: body.kind } : {}),
            ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
          },
        );
        return result
          ? Response.json(result)
          : Response.json({ error: 'Unknown channel allowlist surface' }, { status: 404 });
      },
      postChannelAllowlistEdit: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const result = await this.channelPlugins.editAllowlist(
          surface as import('../channels/index.ts').ChannelSurface,
          {
            ...(Array.isArray(body.add) ? { add: body.add.filter((value): value is string => typeof value === 'string') } : {}),
            ...(Array.isArray(body.remove) ? { remove: body.remove.filter((value): value is string => typeof value === 'string') } : {}),
            ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
            ...(typeof body.channelId === 'string' ? { channelId: body.channelId } : {}),
            ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
            ...(body.kind === 'user' || body.kind === 'channel' || body.kind === 'group' ? { kind: body.kind } : {}),
            ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
          },
        );
        return result
          ? Response.json(result)
          : Response.json({ error: 'Unknown channel allowlist surface' }, { status: 404 });
      },
      getChannelPolicies: () => Response.json({ policies: this.channelPolicy.listPolicies() }),
      postChannelPolicy: async (surface, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const updated = await this.channelPolicy.upsertPolicy(surface as import('../channels/index.ts').ChannelSurface, {
          ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
          ...(body.requireMention !== undefined ? { requireMention: Boolean(body.requireMention) } : {}),
          ...(body.allowDirectMessages !== undefined ? { allowDirectMessages: Boolean(body.allowDirectMessages) } : {}),
          ...(body.allowGroupMessages !== undefined ? { allowGroupMessages: Boolean(body.allowGroupMessages) } : {}),
          ...(body.allowThreadMessages !== undefined ? { allowThreadMessages: Boolean(body.allowThreadMessages) } : {}),
          ...(body.dmPolicy === 'allow' || body.dmPolicy === 'deny' || body.dmPolicy === 'inherit' ? { dmPolicy: body.dmPolicy } : {}),
          ...(body.groupPolicy === 'allow' || body.groupPolicy === 'deny' || body.groupPolicy === 'inherit' ? { groupPolicy: body.groupPolicy } : {}),
          ...(body.allowTextCommandsWithoutMention !== undefined ? { allowTextCommandsWithoutMention: Boolean(body.allowTextCommandsWithoutMention) } : {}),
          ...(Array.isArray(body.allowlistUserIds) ? { allowlistUserIds: body.allowlistUserIds.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.allowlistChannelIds) ? { allowlistChannelIds: body.allowlistChannelIds.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.allowlistGroupIds) ? { allowlistGroupIds: body.allowlistGroupIds.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.allowedCommands) ? { allowedCommands: body.allowedCommands.filter((value): value is string => typeof value === 'string') } : {}),
          ...(Array.isArray(body.groupPolicies) ? {
            groupPolicies: body.groupPolicies
              .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
              .map((value) => ({
                id: typeof value.id === 'string' ? value.id : `group-policy-${Math.random().toString(36).slice(2, 8)}`,
                ...(typeof value.label === 'string' ? { label: value.label } : {}),
                ...(typeof value.groupId === 'string' ? { groupId: value.groupId } : {}),
                ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
                ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
                ...(value.requireMention !== undefined ? { requireMention: Boolean(value.requireMention) } : {}),
                ...(value.allowGroupMessages !== undefined ? { allowGroupMessages: Boolean(value.allowGroupMessages) } : {}),
                ...(value.allowThreadMessages !== undefined ? { allowThreadMessages: Boolean(value.allowThreadMessages) } : {}),
                ...(value.allowTextCommandsWithoutMention !== undefined ? { allowTextCommandsWithoutMention: Boolean(value.allowTextCommandsWithoutMention) } : {}),
                ...(Array.isArray(value.allowlistUserIds) ? { allowlistUserIds: value.allowlistUserIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
                ...(Array.isArray(value.allowlistChannelIds) ? { allowlistChannelIds: value.allowlistChannelIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
                ...(Array.isArray(value.allowlistGroupIds) ? { allowlistGroupIds: value.allowlistGroupIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
                ...(Array.isArray(value.allowedCommands) ? { allowedCommands: value.allowedCommands.filter((entry): entry is string => typeof entry === 'string') } : {}),
                ...(typeof value.metadata === 'object' && value.metadata !== null ? { metadata: value.metadata as Record<string, unknown> } : {}),
              })),
          } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        });
        return Response.json(updated);
      },
      getChannelPolicyAudit: (limit) => Response.json({ audit: this.channelPolicy.listAudit(limit) }),
      getChannelStatus: () => this.channelPlugins.listStatus().then((channels) => Response.json({ channels })),
      getChannelDirectory: (surface, url) => this.channelPlugins.queryDirectory(
        surface as import('../channels/index.ts').ChannelSurface,
        {
          query: url.searchParams.get('q') ?? '',
          ...(url.searchParams.get('scope') ? { scope: url.searchParams.get('scope') as import('../channels/index.ts').ChannelDirectoryScope } : {}),
          ...(url.searchParams.get('groupId') ? { groupId: url.searchParams.get('groupId') as string } : {}),
          ...(url.searchParams.get('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.get('live') ? { live: url.searchParams.get('live') === 'true' } : {}),
        },
      ).then((entries) => Response.json({ entries })),
      getWatchers: () => Response.json({ watchers: this.watcherRegistry.list() }),
      postWatcher: (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        return this.handleRegisterWatcher(request);
      },
      patchWatcher: (watcherId, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        return this.handleUpdateWatcher(watcherId, request);
      },
      watcherAction: (watcherId, action) => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return this.handleWatcherAction(watcherId, action);
      },
      deleteWatcher: (watcherId) => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        const removed = this.watcherRegistry.removeWatcher(watcherId);
        return removed
          ? Response.json({ removed: true, id: watcherId })
          : Response.json({ error: 'Unknown watcher' }, { status: 404 });
      },
      getServiceStatus: () => Response.json({
        ...this.platformServiceManager.status(),
        network: {
          controlPlane: inspectInboundTls(this.configManager, 'controlPlane'),
          httpListener: inspectInboundTls(this.configManager, 'httpListener'),
          outbound: inspectOutboundTls(this.configManager),
        },
      }),
      installService: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.platformServiceManager.install());
      },
      startService: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.platformServiceManager.start());
      },
      stopService: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.platformServiceManager.stop());
      },
      restartService: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.platformServiceManager.restart());
      },
      uninstallService: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.platformServiceManager.uninstall());
      },
      getRouteBindings: () => Response.json({ bindings: this.routeBindings.listBindings() }),
      postRouteBinding: async (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const surfaceKind = typeof body.surfaceKind === 'string' ? body.surfaceKind : '';
        const kind = typeof body.kind === 'string' ? body.kind : '';
        const surfaceId = typeof body.surfaceId === 'string' ? body.surfaceId : '';
        const externalId = typeof body.externalId === 'string' ? body.externalId : '';
        if (!surfaceKind || !kind || !surfaceId || !externalId) {
          return Response.json({ error: 'Missing required route binding fields' }, { status: 400 });
        }
        const binding = await this.routeBindings.upsertBinding({
          id: typeof body.id === 'string' ? body.id : undefined,
          kind: kind as import('../automation/routes.ts').AutomationRouteBinding['kind'],
          surfaceKind: surfaceKind as import('../automation/types.ts').AutomationSurfaceKind,
          surfaceId,
          externalId,
          threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
          channelId: typeof body.channelId === 'string' ? body.channelId : undefined,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
          runId: typeof body.runId === 'string' ? body.runId : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
        });
        return Response.json(binding, { status: 201 });
      },
      patchRouteBinding: async (bindingId, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const updated = await this.routeBindings.patchBinding(bindingId, {
          ...(body.threadId !== undefined ? { threadId: typeof body.threadId === 'string' ? body.threadId : undefined } : {}),
          ...(body.channelId !== undefined ? { channelId: typeof body.channelId === 'string' ? body.channelId : undefined } : {}),
          ...(body.sessionId !== undefined ? { sessionId: body.sessionId === null ? null : typeof body.sessionId === 'string' ? body.sessionId : undefined } : {}),
          ...(body.jobId !== undefined ? { jobId: body.jobId === null ? null : typeof body.jobId === 'string' ? body.jobId : undefined } : {}),
          ...(body.runId !== undefined ? { runId: body.runId === null ? null : typeof body.runId === 'string' ? body.runId : undefined } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
        });
        return updated
          ? Response.json(updated)
          : Response.json({ error: 'Unknown route binding' }, { status: 404 });
      },
      deleteRouteBinding: async (bindingId) => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        const removed = await this.routeBindings.removeBinding(bindingId);
        return removed
          ? Response.json({ removed: true, id: bindingId })
          : Response.json({ error: 'Unknown route binding' }, { status: 404 });
      },
      getApprovals: () => Response.json(getIntegrationApprovalSnapshot()),
      approvalAction: (approvalId, action, request) => this.handleApprovalAction(approvalId, action, request),
      getRemote: () => Response.json(getIntegrationRemoteSnapshot()),
      ...createDaemonRemoteRouteHandlers({
        authToken: this.authToken,
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireAdmin: (request) => this.requireAdmin(request),
        requireRemotePeer: (request, scope) => this.requireRemotePeer(request, scope),
        requireAuthenticatedSession: (request) => this.requireAuthenticatedSession(request),
        distributedRuntime: this.distributedRuntime,
      }),
      getHealth: () => Response.json(getIntegrationHealthSnapshot()),
      getAccounts: async () => {
        const [snapshot, channelAccounts] = await Promise.all([
          getIntegrationAccountsSnapshot(),
          this.channelPlugins.listAccounts(),
        ]);
        return Response.json({
          ...snapshot,
          channelCount: channelAccounts.length,
          channels: channelAccounts,
        });
      },
      getProviders: async () => Response.json({ providers: await listProviderRuntimeSnapshots() }),
      getProvider: async (providerId) => {
        const provider = await getProviderRuntimeSnapshot(providerId);
        return provider
          ? Response.json(provider)
          : Response.json({ error: 'Unknown provider' }, { status: 404 });
      },
      getProviderUsage: async (providerId) => {
        const usage = await getProviderUsageSnapshot(providerId);
        return usage
          ? Response.json(usage)
          : Response.json({ error: 'Unknown provider' }, { status: 404 });
      },
      getSettings: () => Response.json(getIntegrationSettingsSnapshot()),
      getContinuity: () => Response.json(getIntegrationContinuitySnapshot()),
      getWorktrees: () => Response.json(getIntegrationWorktreeSnapshot()),
      getIntelligence: () => Response.json(getIntegrationIntelligenceSnapshot()),
      getMemoryDoctor: async () => Response.json(await getMemoryRegistry().doctor()),
      getMemoryVectorStats: () => Response.json({ vector: getMemoryRegistry().vectorStats() }),
      postMemoryVectorRebuild: async (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        return Response.json({ vector: await getMemoryRegistry().rebuildVectorsAsync() });
      },
      postMemoryEmbeddingDefault: async (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const providerId = typeof body.providerId === 'string' ? body.providerId : '';
        if (!providerId) return Response.json({ error: 'Missing providerId' }, { status: 400 });
        try {
          MemoryEmbeddingProviderRegistry.getActive().setDefaultProvider(providerId);
          return Response.json(await getMemoryRegistry().doctor());
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
        }
      },
      ...createDaemonKnowledgeRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        parseJsonText: (raw) => this.parseJsonText(raw),
        requireAdmin: (request) => this.requireAdmin(request),
        describeAuthenticatedPrincipal: (token) => this.describeAuthenticatedPrincipal(token),
        extractAuthToken: (request) => this.extractAuthToken(request),
        knowledgeService: this.knowledgeService,
        knowledgeGraphqlService: this.knowledgeGraphqlService,
      }),
      ...createDaemonMediaRouteHandlers({
        parseJsonBody: (request) => this.parseJsonBody(request),
        voiceService: this.voiceService,
        configManager: this.configManager,
        webSearchService: this.webSearchService,
        artifactStore: this.artifactStore,
        mediaProviders: this.mediaProviders,
        multimodalService: this.multimodalService,
      }),
      getLocalAuth: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(getIntegrationLocalAuthSnapshot());
      },
      postLocalAuthUser: async (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const username = typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const roles = Array.isArray(body.roles) ? body.roles.filter((value): value is string => typeof value === 'string') : ['admin'];
        try {
          return Response.json({ user: this.userAuth.addUser(username, password, roles) }, { status: 201 });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
      },
      deleteLocalAuthUser: (username) => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        try {
          const removed = this.userAuth.deleteUser(username);
          return removed
            ? Response.json({ deleted: true })
            : Response.json({ error: 'Unknown user' }, { status: 404 });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
      },
      postLocalAuthPassword: async (username, request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const password = typeof body.password === 'string' ? body.password : '';
        try {
          this.userAuth.rotatePassword(username, password);
          return Response.json({ rotated: true });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 400 });
        }
      },
      deleteLocalAuthSession: (sessionId) => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return this.userAuth.revokeSession(sessionId)
          ? Response.json({ revoked: true })
          : Response.json({ error: 'Unknown session' }, { status: 404 });
      },
      deleteBootstrapFile: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json({ removed: this.userAuth.clearBootstrapCredentialFile() });
      },
      getPanels: () => Response.json({ panels: listIntegrationPanels() }),
      postPanelOpen: async (request) => {
        const body = await this.parseJsonBody(request);
        if (body instanceof Response) return body;
        const panelId = typeof body.id === 'string' ? body.id : '';
        const pane = body.pane === 'bottom' ? 'bottom' : 'top';
        if (!panelId) return Response.json({ error: 'Missing panel id' }, { status: 400 });
        const ok = openIntegrationPanel(panelId, pane);
        return ok
          ? Response.json({ opened: true, id: panelId, pane })
          : Response.json({ error: `Unknown panel: ${panelId}` }, { status: 404 });
      },
      getEvents: (request) => {
        const url = new URL(request.url);
        const rawDomains = url.searchParams.get('domains');
        const domains = (rawDomains ? rawDomains.split(',').map((value) => value.trim()).filter(Boolean) : []) as RuntimeEventDomain[];
        return createIntegrationEventStream(request, domains);
      },
      getConfig: () => {
        const admin = this.requireAdmin(req);
        if (admin) return admin;
        return Response.json(this.configManager.getAll());
      },
      postConfig: async (request) => {
        const admin = this.requireAdmin(request);
        if (admin) return admin;
        let payload: { key?: string; value?: unknown };
        try {
          payload = await request.json() as { key?: string; value?: unknown };
        } catch {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        const { key, value } = payload;
        if (!key || typeof key !== 'string') {
          return Response.json({ error: 'Missing or invalid key' }, { status: 400 });
        }
        if (!isValidConfigKey(key)) {
          return Response.json({ error: 'Invalid config key' }, { status: 400 });
        }
        try {
          this.configManager.setDynamic(key as ConfigKey, value);
        } catch (e: unknown) {
          return Response.json({ error: e instanceof Error ? e.message : 'Failed to set config' }, { status: 400 });
        }
        return Response.json({ success: true, key, value });
      },
      postTask: (request) => this.handlePostTask(request),
      getSharedSession: async (sessionId) => this.handleGetSharedSession(sessionId),
      closeSharedSession: (sessionId) => this.handleSharedSessionLifecycle(sessionId, 'close'),
      reopenSharedSession: (sessionId) => this.handleSharedSessionLifecycle(sessionId, 'reopen'),
      getSharedSessionMessages: async (sessionId, requestUrl) => this.handleGetSharedSessionMessages(sessionId, requestUrl),
      postSharedSessionMessage: (sessionId, request) => this.handlePostSharedSessionMessage(sessionId, request),
      getRuntimeTask: (taskId) => this.handleGetRuntimeTask(taskId),
      runtimeTaskAction: (taskId, action, request) => this.handleRuntimeTaskAction(taskId, action, request),
      getTaskStatus: (agentId) => this.handleGetTaskStatus(agentId),
      getSchedules: () => this.handleGetSchedules(),
      postSchedule: (request) => this.handlePostSchedule(request),
      deleteSchedule: async (scheduleId) => this.handleDeleteSchedule(scheduleId),
      setScheduleEnabled: (scheduleId, enabled) => this.handleSetScheduleEnabled(scheduleId, enabled),
      runScheduleNow: (scheduleId) => this.handleRunScheduleNow(scheduleId),
    });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.userAuth.authenticate(username, password);

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.userAuth.createSession(user.username);
    return Response.json({
      authenticated: true,
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
    });
  }

  private async handlePostTask(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const task = body.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      return Response.json({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
    }

    const model = typeof body.model === 'string' ? body.model : undefined;
    const tools = Array.isArray(body.tools)
      ? (body.tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    const wantsSharedSession = typeof body.sessionId === 'string'
      || typeof body.routeId === 'string'
      || typeof body.surfaceKind === 'string';
    if (wantsSharedSession) {
      const submission = await this.sessionBroker.submitMessage({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
        surfaceKind: typeof body.surfaceKind === 'string'
          ? body.surfaceKind as import('../automation/types.ts').AutomationSurfaceKind
          : 'web',
        surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
        externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        userId: typeof body.userId === 'string' ? body.userId : undefined,
        displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        body: task.trim(),
        metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      });

      if (submission.mode === 'continued-live') {
        return this.recordApiResponse(req, '/task', Response.json({
          acknowledged: true,
          mode: submission.mode,
          sessionId: submission.session.id,
          agentId: submission.activeAgentId ?? null,
        }, { status: 202 }));
      }

      const sessionSpawn = this.trySpawnAgent({
        mode: 'spawn',
        task: submission.task!,
        ...(model !== undefined && { model }),
        ...(tools !== undefined && { tools }),
      }, 'DaemonServer.handlePostTask.sharedSession', submission.session.id);
      if (sessionSpawn instanceof Response) return sessionSpawn;
      await this.sessionBroker.bindAgent(submission.session.id, sessionSpawn.id);
      this.queueSurfaceReplyFromBinding(submission.routeBinding, {
        agentId: sessionSpawn.id,
        task,
        sessionId: submission.session.id,
      });
      return this.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: sessionSpawn.id,
        status: sessionSpawn.status,
      }, { status: 202 }));
    }

    const spawnResult = this.trySpawnAgent({
      mode: 'spawn',
      task,
      ...(model !== undefined && { model }),
      ...(tools !== undefined && { tools }),
    }, 'DaemonServer', typeof body.sessionId === 'string' ? body.sessionId : undefined);
    if (spawnResult instanceof Response) return spawnResult;
    const record = spawnResult;

    return this.recordApiResponse(req, '/task', Response.json(
      {
        acknowledged: true,
        agentId: record.id,
        status: record.status,
        task: record.task,
        model: record.model ?? null,
        tools: record.tools,
      },
      { status: 202 },
    ));
  }

  // -------------------------------------------------------------------------
  // GitHub webhook handler
  // -------------------------------------------------------------------------

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    return handleGitHubAutomationWebhook(req, {
      serviceRegistry: this.serviceRegistry,
      githubWebhookSecret: this.githubWebhookSecret,
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
    });
  }

  // -------------------------------------------------------------------------
  // Webhook handlers
  // -------------------------------------------------------------------------

  private async handleSlackWebhook(req: Request): Promise<Response> {
    return handleSlackSurfaceWebhook(req, this.buildSurfaceAdapterContext());
  }

  private async handleDiscordWebhook(req: Request): Promise<Response> {
    return handleDiscordSurfaceWebhook(req, this.buildSurfaceAdapterContext());
  }

  private async handleNtfyWebhook(req: Request): Promise<Response> {
    return handleNtfySurfaceWebhook(req, this.buildSurfaceAdapterContext());
  }

  private async handleGenericWebhook(req: Request): Promise<Response> {
    return handleGenericWebhookSurface(req, this.buildGenericWebhookAdapterContext());
  }

  private async handleRegisterWatcher(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;
    const label = typeof body.label === 'string' && body.label.trim().length > 0 ? body.label.trim() : '';
    const id = typeof body.id === 'string' && body.id.trim().length > 0
      ? body.id.trim()
      : label
        ? `watcher-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`
        : `watcher-${Date.now()}`;
    const kind = typeof body.kind === 'string'
      ? body.kind as import('../runtime/store/domains/watchers.ts').WatcherKind
      : typeof body.sourceKind === 'string'
        ? body.sourceKind === 'webhook'
          ? 'webhook'
          : body.sourceKind === 'file'
            ? 'filesystem'
            : body.sourceKind === 'stream'
              ? 'socket'
              : body.sourceKind === 'api'
                ? 'integration'
                : 'polling'
        : 'polling';
    const intervalMs = Number(body.intervalMs ?? this.configManager.get('watchers.pollIntervalMs') ?? 60_000);
    if (!label) {
      return Response.json({ error: 'Missing watcher label' }, { status: 400 });
    }
    const metadata = typeof body.metadata === 'object' && body.metadata !== null
      ? body.metadata as Record<string, unknown>
      : {};
    const sourceMetadata = {
      ...metadata,
      ...(typeof body.url === 'string' ? { url: body.url } : {}),
      ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
      ...(typeof body.address === 'string' ? { address: body.address } : {}),
      ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
    };
    const record = this.watcherRegistry.registerWatcher({
      id,
      label,
      kind,
      source: {
        id: typeof body.sourceId === 'string' && body.sourceId.trim() ? body.sourceId.trim() : `source:${id}`,
        kind: typeof body.sourceKind === 'string'
          ? body.sourceKind === 'webhook'
            ? 'webhook'
            : body.sourceKind === 'file'
              ? 'hook'
              : body.sourceKind === 'stream'
                ? 'hook'
                : body.sourceKind === 'api'
                  ? 'hook'
                  : 'watcher'
          : 'watcher',
        label,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: sourceMetadata,
      },
      intervalMs,
      metadata: sourceMetadata,
      ...(typeof body.run === 'string'
        ? { run: () => body.run as string }
        : {}),
    });
    return Response.json(record, { status: 201 });
  }

  private async handleUpdateWatcher(watcherId: string, req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;
    const current = this.watcherRegistry.getWatcher(watcherId);
    if (!current) {
      return Response.json({ error: 'Unknown watcher' }, { status: 404 });
    }
    const nextSourceKind = typeof body.sourceKind === 'string'
      ? body.sourceKind === 'webhook'
        ? 'webhook'
        : body.sourceKind === 'file' || body.sourceKind === 'stream' || body.sourceKind === 'api'
          ? 'hook'
          : 'watcher'
      : current.source.kind;
    const updated = this.watcherRegistry.registerWatcher({
      id: watcherId,
      label: typeof body.label === 'string' ? body.label : current.label,
      kind: typeof body.kind === 'string'
        ? body.kind as import('../runtime/store/domains/watchers.ts').WatcherKind
        : current.kind,
      source: {
        ...current.source,
        ...(typeof body.source === 'object' && body.source !== null ? body.source as Partial<typeof current.source> : {}),
        kind: nextSourceKind,
        ...(typeof body.sourceId === 'string' && body.sourceId.trim().length > 0 ? { id: body.sourceId.trim() } : {}),
        ...(typeof body.label === 'string' && body.label.trim().length > 0 ? { label: body.label.trim() } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        metadata: {
          ...current.source.metadata,
          ...(typeof body.url === 'string' ? { url: body.url } : {}),
          ...(typeof body.method === 'string' ? { method: body.method.toUpperCase() } : {}),
          ...(typeof body.path === 'string' ? { path: body.path } : {}),
          ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
          ...(typeof body.address === 'string' ? { address: body.address } : {}),
          ...(typeof body.headers === 'object' && body.headers !== null ? { headers: body.headers } : {}),
          ...(typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {}),
        },
        updatedAt: Date.now(),
      },
      intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : current.intervalMs,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : current.metadata,
    });
    return Response.json(updated);
  }

  private async handleWatcherAction(watcherId: string, action: string): Promise<Response> {
    if (action === 'start') {
      const watcher = this.watcherRegistry.startWatcher(watcherId);
      return watcher
        ? Response.json(watcher)
        : Response.json({ error: 'Unknown watcher' }, { status: 404 });
    }
    if (action === 'stop') {
      const watcher = this.watcherRegistry.stopWatcher(watcherId, 'operator-stop');
      return watcher
        ? Response.json(watcher)
        : Response.json({ error: 'Unknown watcher' }, { status: 404 });
    }
    if (action === 'run') {
      const watcher = await this.watcherRegistry.runWatcherNow(watcherId);
      return watcher
        ? Response.json(watcher)
        : Response.json({ error: 'Unknown watcher' }, { status: 404 });
    }
    return Response.json({ error: 'Unsupported watcher action' }, { status: 400 });
  }

  private handleGetTaskStatus(agentId: string): Response {
    const record = this.agentManager.getStatus(agentId);
    if (!record) {
      return Response.json({ error: `Agent not found: ${agentId}` }, { status: 404 });
    }
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
      this.syncFinishedAgentTask(record);
    }

    const durationMs =
      record.completedAt !== undefined
        ? record.completedAt - record.startedAt
        : Date.now() - record.startedAt;

    return Response.json({
      agentId: record.id,
      task: record.task,
      status: record.status,
      model: record.model ?? null,
      tools: record.tools,
      durationMs,
      toolCallCount: record.toolCallCount,
      progress: record.progress ?? null,
      error: record.error ?? null,
    });
  }

  private async handleCreateSharedSession(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;
    await this.sessionBroker.start();
    await this.routeBindings.start();
    const routeBinding = typeof body.routeId === 'string'
      ? this.routeBindings.getBinding(body.routeId)
      : undefined;
    const session = await this.sessionBroker.createSession({
      id: typeof body.id === 'string' ? body.id : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      routeBinding,
      participant: typeof body.surfaceKind === 'string' && typeof body.surfaceId === 'string'
        ? {
            surfaceKind: body.surfaceKind as import('../automation/types.ts').AutomationSurfaceKind,
            surfaceId: body.surfaceId,
            externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
            userId: typeof body.userId === 'string' ? body.userId : undefined,
            displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
            routeId: routeBinding?.id,
            lastSeenAt: Date.now(),
          }
        : undefined,
    });
    return this.recordApiResponse(req, `/api/sessions`, Response.json({ session }, { status: 201 }));
  }

  private async handleGetSharedSession(sessionId: string): Promise<Response> {
    await this.sessionBroker.start();
    const session = this.sessionBroker.getSession(sessionId);
    if (!session) {
      return Response.json({ error: 'Unknown shared session' }, { status: 404 });
    }
    return Response.json({
      session,
      messages: this.sessionBroker.getMessages(sessionId, 100),
    });
  }

  private async handleSharedSessionLifecycle(sessionId: string, action: string): Promise<Response> {
    await this.sessionBroker.start();
    const session = action === 'close'
      ? await this.sessionBroker.closeSession(sessionId)
      : await this.sessionBroker.reopenSession(sessionId);
    return session
      ? Response.json({ session })
      : Response.json({ error: 'Unknown shared session' }, { status: 404 });
  }

  private async handleGetSharedSessionMessages(sessionId: string, url: URL): Promise<Response> {
    await this.sessionBroker.start();
    const session = this.sessionBroker.getSession(sessionId);
    if (!session) {
      return Response.json({ error: 'Unknown shared session' }, { status: 404 });
    }
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return Response.json({
      session,
      messages: this.sessionBroker.getMessages(sessionId, limit),
    });
  }

  private async handlePostSharedSessionMessage(sessionId: string, req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;
    const message = typeof body.message === 'string'
      ? body.message.trim()
      : typeof body.body === 'string'
        ? body.body.trim()
        : typeof body.text === 'string'
          ? body.text.trim()
          : '';
    if (!message) {
      return Response.json({ error: 'Missing shared session message body' }, { status: 400 });
    }
    const submission = await this.sessionBroker.submitMessage({
      sessionId,
      surfaceKind: typeof body.surfaceKind === 'string' ? body.surfaceKind as import('../automation/types.ts').AutomationSurfaceKind : 'web',
      surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      body: message,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    });

    if (submission.mode === 'continued-live') {
      return this.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
        session: submission.session,
        message: submission.userMessage,
        mode: submission.mode,
        agentId: submission.activeAgentId ?? null,
      }, { status: 202 }));
    }

    const spawnResult = this.trySpawnAgent({
      mode: 'spawn',
      task: submission.task!,
      context: `shared-session:${submission.session.id}`,
    }, 'DaemonServer.handlePostSharedSessionMessage');
    if (spawnResult instanceof Response) return spawnResult;
    await this.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
    this.queueSurfaceReplyFromBinding(submission.routeBinding, {
      agentId: spawnResult.id,
      task: message,
      sessionId: submission.session.id,
    });
    return this.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
      session: this.sessionBroker.getSession(submission.session.id),
      message: submission.userMessage,
      mode: submission.mode,
      agentId: spawnResult.id,
    }, { status: 202 }));
  }

  private handleGetRuntimeTask(taskId: string): Response {
    const runtimeStore = getIntegrationHelpersContextOptional()?.runtimeStore;
    const task = runtimeStore?.getState().tasks.tasks.get(taskId);
    if (!task) {
      return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
    }
    return Response.json({ task });
  }

  private handleRuntimeTaskAction(taskId: string, action: string, _req: Request): Response {
    const integrationContext = getIntegrationHelpersContextOptional();
    const runtimeStore = integrationContext?.runtimeStore;
    if (!runtimeStore) {
      return Response.json({ error: 'Runtime store unavailable' }, { status: 503 });
    }
    const dispatch = createDomainDispatch(runtimeStore);
    const task = runtimeStore.getState().tasks.tasks.get(taskId);
    if (!task) {
      return Response.json({ error: 'Unknown runtime task' }, { status: 404 });
    }
    if (action === 'cancel') {
      if (task.kind === 'agent' && task.owner) {
        this.agentManager.cancel(task.owner);
      }
      dispatch.transitionRuntimeTask(taskId, 'cancelled', {
        endedAt: Date.now(),
        error: 'Cancelled via control plane',
      }, 'daemon.server.tasks.cancel');
      return Response.json({ task: runtimeStore.getState().tasks.tasks.get(taskId) });
    }
    if (action === 'retry') {
      if (task.kind !== 'agent') {
        return Response.json({ error: 'Retry is only implemented for agent tasks' }, { status: 400 });
      }
      const spawnResult = this.trySpawnAgent({
        mode: 'spawn',
        task: task.description ?? task.title,
      }, 'DaemonServer.handleRuntimeTaskAction');
      if (spawnResult instanceof Response) return spawnResult;
      dispatch.transitionRuntimeTask(taskId, 'queued', {
        startedAt: undefined,
        endedAt: undefined,
        error: undefined,
        result: undefined,
      }, 'daemon.server.tasks.retry');
      return Response.json({
        retried: true,
        task: runtimeStore.getState().tasks.tasks.get(taskId),
        agentId: spawnResult.id,
      });
    }
    return Response.json({ error: 'Unsupported task action' }, { status: 400 });
  }

  private handleGetAutomationRun(runId: string): Response {
    const run = this.automationManager.getRun(runId);
    if (!run) {
      return Response.json({ error: 'Unknown automation run' }, { status: 404 });
    }
    const runtimeStore = getIntegrationHelpersContextOptional()?.runtimeStore;
    const deliveries = runtimeStore
      ? [...runtimeStore.getState().deliveries.deliveryAttempts.values()].filter((attempt) => attempt.runId === run.id)
      : [];
    return Response.json({ run, deliveries });
  }

  private async handleAutomationRunAction(runId: string, action: string, req: Request): Promise<Response> {
    if (action === 'cancel') {
      const body = await this.parseOptionalJsonBody(req);
      const reason = body instanceof Response
        ? 'operator-cancelled'
        : body && typeof body.reason === 'string'
          ? body.reason
          : 'operator-cancelled';
      const run = await this.automationManager.cancelRun(runId, reason);
      return run
        ? this.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }))
        : this.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ error: 'Unknown automation run' }, { status: 404 }));
    }
    if (action === 'retry') {
      try {
        const run = await this.automationManager.retryRun(runId);
        return this.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ run }, { status: 202 }));
      } catch (error) {
        return this.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({
          error: error instanceof Error ? error.message : 'Failed to retry automation run',
        }, { status: 400 }));
      }
    }
    return this.recordApiResponse(req, `/api/automation/runs/${runId}/${action}`, Response.json({ error: 'Unsupported automation run action' }, { status: 400 }));
  }

  private handleGetDelivery(deliveryId: string): Response {
    const runtimeStore = getIntegrationHelpersContextOptional()?.runtimeStore;
    const delivery = runtimeStore?.getState().deliveries.deliveryAttempts.get(deliveryId);
    if (!delivery) {
      return Response.json({ error: 'Unknown delivery' }, { status: 404 });
    }
    return Response.json({ delivery });
  }

  private async handleApprovalAction(approvalId: string, action: string, req: Request): Promise<Response> {
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

  // -------------------------------------------------------------------------
  // Schedule handlers
  // -------------------------------------------------------------------------

  private handleGetSchedules(): Response {
    const jobs = this.automationManager.listJobs();
    const runs = this.automationManager.listRuns().slice(0, 50);
    return Response.json({ jobs, runs });
  }

  private async handlePostSchedule(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
    const kind = typeof body.kind === 'string' ? body.kind : 'cron';
    const cron = typeof body.cron === 'string' ? body.cron : undefined;
    const every = typeof body.every === 'string' ? body.every : undefined;
    const at = typeof body.at === 'string' || typeof body.at === 'number' ? body.at : undefined;
    const timezone = typeof body.timezone === 'string' ? body.timezone : undefined;
    if (!prompt) {
      return Response.json({ error: 'Missing required field: prompt (string)' }, { status: 400 });
    }

    // Validate prompt length (injection / DoS mitigation)
    if (prompt.length > 10_000) {
      return Response.json({ error: 'prompt exceeds maximum length of 10000 characters' }, { status: 400 });
    }

    try {
      const schedule = kind === 'every'
        ? normalizeEverySchedule(every ?? '')
        : kind === 'at'
          ? normalizeAtSchedule(typeof at === 'number' ? at : Date.parse(String(at)))
          : normalizeCronSchedule(cron ?? '', timezone, body.staggerMs ?? body.stagger);
      const name = typeof body.name === 'string' ? body.name : prompt.slice(0, 40);
      const model = typeof body.model === 'string' ? body.model : undefined;
      const provider = typeof body.provider === 'string' ? body.provider : undefined;
      const template = typeof body.template === 'string' ? body.template : undefined;
      const fallbackModels = readStringList(body.fallbackModels ?? body.fallbacks);
      const enabled = body.enabled !== false;
      const target = typeof body.target === 'object' && body.target !== null
        ? body.target as import('../automation/session-targets.ts').AutomationSessionTarget
        : undefined;
      const delivery = typeof body.delivery === 'object' && body.delivery !== null
        ? body.delivery as Partial<import('../automation/delivery.ts').AutomationDeliveryPolicy>
        : undefined;
      const failure = typeof body.failure === 'object' && body.failure !== null
        ? body.failure as Partial<import('../automation/failures.ts').AutomationFailurePolicy>
        : undefined;
      const job = await this.automationManager.createJob({
        name,
        prompt,
        schedule,
        description: prompt,
        model,
        provider,
        fallbackModels,
        template,
        target,
        reasoningEffort: readAutomationReasoningEffort(body.reasoningEffort),
        thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
        wakeMode: readAutomationWakeMode(body.wakeMode),
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        toolAllowlist: Array.isArray(body.toolAllowlist)
          ? body.toolAllowlist.filter((value): value is string => typeof value === 'string')
          : undefined,
        autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : undefined,
        allowUnsafeExternalContent: typeof body.allowUnsafeExternalContent === 'boolean' ? body.allowUnsafeExternalContent : undefined,
        externalContentSource: readExternalContentSource(body.externalContentSource),
        lightContext: typeof body.lightContext === 'boolean' ? body.lightContext : undefined,
        delivery,
        failure,
        enabled,
        deleteAfterRun: typeof body.deleteAfterRun === 'boolean' ? body.deleteAfterRun : undefined,
      });
      return Response.json(job, { status: 201 });
    } catch (e: unknown) {
      return Response.json({ error: e instanceof Error ? e.message : 'Failed to create schedule' }, { status: 400 });
    }
  }

  private async handlePatchSchedule(id: string, req: Request): Promise<Response> {
    const job = this.findSchedule(id);
    if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;
    try {
      const updated = await this.automationManager.updateJob(job.id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        schedule: typeof body.schedule === 'object' && body.schedule !== null
          ? body.schedule as import('../automation/schedules.ts').AutomationScheduleDefinition
          : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        fallbackModels: readStringList(body.fallbackModels ?? body.fallbacks),
        template: typeof body.template === 'string' ? body.template : undefined,
        target: typeof body.target === 'object' && body.target !== null
          ? body.target as import('../automation/session-targets.ts').AutomationSessionTarget
          : undefined,
        reasoningEffort: readAutomationReasoningEffort(body.reasoningEffort),
        thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
        wakeMode: readAutomationWakeMode(body.wakeMode),
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        toolAllowlist: Array.isArray(body.toolAllowlist)
          ? body.toolAllowlist.filter((value): value is string => typeof value === 'string')
          : undefined,
        autoApprove: typeof body.autoApprove === 'boolean' ? body.autoApprove : undefined,
        allowUnsafeExternalContent: typeof body.allowUnsafeExternalContent === 'boolean' ? body.allowUnsafeExternalContent : undefined,
        externalContentSource: readExternalContentSource(body.externalContentSource),
        lightContext: typeof body.lightContext === 'boolean' ? body.lightContext : undefined,
        delivery: typeof body.delivery === 'object' && body.delivery !== null
          ? body.delivery as Partial<import('../automation/delivery.ts').AutomationDeliveryPolicy>
          : undefined,
        failure: typeof body.failure === 'object' && body.failure !== null
          ? body.failure as Partial<import('../automation/failures.ts').AutomationFailurePolicy>
          : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        deleteAfterRun: typeof body.deleteAfterRun === 'boolean' ? body.deleteAfterRun : undefined,
      });
      return updated
        ? Response.json(updated)
        : Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Failed to update schedule' }, { status: 400 });
    }
  }

  private async handleDeleteSchedule(id: string): Promise<Response> {
    const job = this.findSchedule(id);
    if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    await this.automationManager.removeJob(job.id);
    return Response.json({ removed: true, id: job.id });
  }

  private async handleSetScheduleEnabled(id: string, enabled: boolean): Promise<Response> {
    const job = this.findSchedule(id);
    if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    const updated = await this.automationManager.setEnabled(job.id, enabled);
    return Response.json(updated ?? { id: job.id, enabled });
  }

  private async handleRunScheduleNow(id: string): Promise<Response> {
    const job = this.findSchedule(id);
    if (!job) return Response.json({ error: `Schedule not found: ${id}` }, { status: 404 });
    try {
      const run = await this.automationManager.runNow(job.id);
      return Response.json({ jobId: job.id, runId: run.id, agentId: run.agentId, status: run.status });
    } catch (e: unknown) {
      return Response.json({ error: e instanceof Error ? e.message : 'Failed to run schedule' }, { status: 500 });
    }
  }

  private async parseJsonBody(req: Request): Promise<JsonBody | Response> {
    try {
      return await req.json() as JsonBody;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  private async parseOptionalJsonBody(req: Request): Promise<JsonBody | null | Response> {
    const raw = await req.text();
    if (!raw.trim()) return null;
    return this.parseJsonText(raw);
  }

  private parseJsonText(rawBody: string): JsonBody | Response {
    try {
      return JSON.parse(rawBody) as JsonBody;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
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
    this.controlPlaneGateway.recordApiRequest({
      method: req.method,
      path,
      status: response.status,
      clientKind,
      ...(response.status >= 400 ? { error: `${req.method} ${path} -> ${response.status}` } : {}),
    });
    return response;
  }

  private queueSurfaceReplyFromBinding(
    binding: import('../automation/routes.ts').AutomationRouteBinding | undefined,
    input: {
      readonly agentId: string;
      readonly task: string;
      readonly sessionId?: string;
    },
  ): void {
    if (!binding) return;
    if (binding.surfaceKind === 'slack' && this.surfaceDeliveryEnabled('slack')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'slack',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        responseUrl: typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl : undefined,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'discord' && this.surfaceDeliveryEnabled('discord')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'discord',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        applicationId: typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined,
        interactionToken: typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'ntfy' && this.surfaceDeliveryEnabled('ntfy')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'ntfy',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        topic: binding.channelId ?? binding.externalId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'webhook' && this.surfaceDeliveryEnabled('webhook')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'webhook',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        callbackUrl: typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl : undefined,
        callbackCorrelationId: typeof binding.metadata.correlationId === 'string' ? binding.metadata.correlationId : undefined,
        callbackSignature: typeof binding.metadata.callbackSignature === 'string'
          ? binding.metadata.callbackSignature as PendingSurfaceReply['callbackSignature']
          : undefined,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'telegram' && this.surfaceDeliveryEnabled('telegram')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'telegram',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'google-chat' && this.surfaceDeliveryEnabled('google-chat')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'google-chat',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'signal' && this.surfaceDeliveryEnabled('signal')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'signal',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'whatsapp' && this.surfaceDeliveryEnabled('whatsapp')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'whatsapp',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'imessage' && this.surfaceDeliveryEnabled('imessage')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'imessage',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'msteams' && this.surfaceDeliveryEnabled('msteams')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'msteams',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'bluebubbles' && this.surfaceDeliveryEnabled('bluebubbles')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'bluebubbles',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'mattermost' && this.surfaceDeliveryEnabled('mattermost')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'mattermost',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
      return;
    }
    if (binding.surfaceKind === 'matrix' && this.surfaceDeliveryEnabled('matrix')) {
      this.pendingSurfaceReplies.set(input.agentId, {
        agentId: input.agentId,
        surfaceKind: 'matrix',
        task: input.task,
        createdAt: Date.now(),
        sessionId: input.sessionId,
        routeId: binding.id,
        channelId: binding.channelId,
        targetAddress: binding.channelId ?? binding.externalId,
        threadId: binding.threadId,
      });
      this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
    }
  }

  private queueWebhookReply(input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly callbackUrl?: string;
    readonly callbackCorrelationId?: string;
    readonly callbackSignature?: PendingSurfaceReply['callbackSignature'];
  }): void {
    this.pendingSurfaceReplies.set(input.agentId, {
      agentId: input.agentId,
      surfaceKind: 'webhook',
      task: input.task,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: input.routeId,
      callbackUrl: input.callbackUrl,
      callbackCorrelationId: input.callbackCorrelationId,
      callbackSignature: input.callbackSignature,
    });
    this.channelReplyPipeline.trackPending(this.pendingSurfaceReplies.get(input.agentId)!);
  }

  private parseSurfaceControlCommand(text: string): { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string } | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^(status|cancel|retry)\s+([a-z0-9:_-]+)/i);
    if (!match) return null;
    return {
      action: match[1]!.toLowerCase() as 'status' | 'cancel' | 'retry',
      id: match[2]!,
    };
  }

  private async performSurfaceControlCommand(command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string }): Promise<string> {
    if (command.action === 'status') {
      const run = this.automationManager.getRun(command.id);
      if (run) {
        return `Run ${run.id}: ${run.status}${run.agentId ? ` agent=${run.agentId}` : ''}`;
      }
      const agent = this.agentManager.getStatus(command.id);
      if (agent) {
        return `Agent ${agent.id}: ${agent.status}${agent.progress ? ` (${agent.progress})` : ''}`;
      }
      const session = this.sessionBroker.getSession(command.id);
      if (session) {
        return `Session ${session.id}: ${session.status} messages=${session.messageCount}${session.activeAgentId ? ` activeAgent=${session.activeAgentId}` : ''}`;
      }
      return `Unknown run, agent, or session: ${command.id}`;
    }

    if (command.action === 'cancel') {
      const run = await this.automationManager.cancelRun(command.id, 'surface-cancelled');
      if (run) {
        return `Cancelled run ${run.id}`;
      }
      const agent = this.agentManager.getStatus(command.id);
      if (agent) {
        this.agentManager.cancel(command.id);
        return `Cancelled agent ${command.id}`;
      }
      return `Unknown run or agent: ${command.id}`;
    }

    try {
      const run = await this.automationManager.retryRun(command.id);
      return `Retried run ${run.id}`;
    } catch {
      const agent = this.agentManager.getStatus(command.id);
      if (agent) {
        const retried = this.trySpawnAgent({
          mode: 'spawn',
          task: agent.task,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.tools.length > 0 ? { tools: agent.tools } : {}),
        }, 'DaemonServer.performSurfaceControlCommand');
        if (!(retried instanceof Response)) {
          return `Retried agent ${command.id} as ${retried.id}`;
        }
      }
      return `Unable to retry ${command.id}`;
    }
  }

  private async performInteractiveSurfaceAction(
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
  ): Promise<string> {
    const approvalMatch = actionId.match(/^gv:approval:(approve|deny|claim):(.+)$/);
    if (approvalMatch) {
      const [, action, approvalId] = approvalMatch;
      const result = await this.handleApprovalAction(approvalId, action, new Request(req.url, {
        method: 'POST',
        headers: req.headers,
      }));
      const body = await result.json().catch(() => ({} as Record<string, unknown>));
      return result.ok
        ? `Approval ${action}d: ${approvalId}`
        : String((body as Record<string, unknown>).error ?? `Failed to ${action} approval ${approvalId}`);
    }
    const runMatch = actionId.match(/^gv:run:(cancel|retry):(.+)$/);
    if (runMatch) {
      const [, action, runId] = runMatch;
      const result = await this.handleAutomationRunAction(runId, action, new Request(req.url, {
        method: 'POST',
        headers: req.headers,
      }));
      const body = await result.json().catch(() => ({} as Record<string, unknown>));
      return result.ok
        ? `${action === 'cancel' ? 'Cancelled' : 'Retried'} run ${runId}`
        : String((body as Record<string, unknown>).error ?? `Failed to ${action} run ${runId}`);
    }
    return `No handler for ${surface} action ${actionId}`;
  }

  private trySpawnAgent(
    input: Parameters<AgentManager['spawn']>[0],
    logLabel = 'DaemonServer',
    sessionId?: string,
  ): AgentRecord | Response {
    try {
      const record = this.agentManager.spawn(input);
      this.syncSpawnedAgentTask(record, sessionId);
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`${logLabel}: agent spawn failed`, { error: message });
      return Response.json({ error: `Failed to spawn agent: ${message}` }, { status: 500 });
    }
  }

  private syncSpawnedAgentTask(record: AgentRecord, sessionId?: string): void {
    const runtimeStore = getIntegrationHelpersContextOptional()?.runtimeStore;
    if (!runtimeStore) return;
    const dispatch = createDomainDispatch(runtimeStore);
    dispatch.syncRuntimeTask({
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
    const runtimeStore = getIntegrationHelpersContextOptional()?.runtimeStore;
    if (!runtimeStore) return;
    const dispatch = createDomainDispatch(runtimeStore);
    const status = record.status === 'completed'
      ? 'completed'
      : record.status === 'failed'
        ? 'failed'
        : 'cancelled';
    dispatch.transitionRuntimeTask(record.id, status, {
      endedAt: record.completedAt ?? Date.now(),
      result: record.fullOutput ?? record.streamingContent,
      error: record.error,
    }, 'daemon.server.agent-finish');
  }

  private findSchedule(id: string): AutomationJob | undefined {
    return this.automationManager.listJobs().find((job) => job.id === id || job.id.startsWith(id));
  }

  private surfaceDeliveryEnabled(
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ): boolean {
    if (surface === 'slack') {
      return Boolean(this.configManager.get('surfaces.slack.enabled') || process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN || process.env.SLACK_WEBHOOK_URL);
    }
    if (surface === 'discord') {
      return Boolean(this.configManager.get('surfaces.discord.enabled') || process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_WEBHOOK_URL);
    }
    if (surface === 'webhook') {
      return Boolean(this.configManager.get('surfaces.webhook.enabled') || this.configManager.get('surfaces.webhook.defaultTarget'));
    }
    if (surface === 'ntfy') {
      return Boolean(this.configManager.get('surfaces.ntfy.enabled') || this.configManager.get('surfaces.ntfy.topic') || process.env.NTFY_ACCESS_TOKEN);
    }
    const surfaces = this.configManager.getCategory('surfaces');
    if (surface === 'telegram') {
      return Boolean(surfaces.telegram.enabled || surfaces.telegram.botToken || surfaces.telegram.defaultChatId || process.env.TELEGRAM_BOT_TOKEN);
    }
    if (surface === 'google-chat') {
      return Boolean(surfaces.googleChat.enabled || surfaces.googleChat.webhookUrl || surfaces.googleChat.spaceId || process.env.GOOGLE_CHAT_WEBHOOK_URL);
    }
    if (surface === 'signal') {
      return Boolean(surfaces.signal.enabled || surfaces.signal.bridgeUrl || surfaces.signal.account || process.env.SIGNAL_BRIDGE_TOKEN);
    }
    if (surface === 'whatsapp') {
      return Boolean(surfaces.whatsapp.enabled || surfaces.whatsapp.accessToken || surfaces.whatsapp.phoneNumberId || process.env.WHATSAPP_ACCESS_TOKEN);
    }
    if (surface === 'imessage') {
      return Boolean(surfaces.imessage.enabled || surfaces.imessage.bridgeUrl || surfaces.imessage.account || process.env.IMESSAGE_BRIDGE_TOKEN);
    }
    if (surface === 'msteams') {
      return Boolean(surfaces.msteams.enabled || surfaces.msteams.appId || surfaces.msteams.defaultConversationId || process.env.MSTEAMS_APP_ID);
    }
    if (surface === 'bluebubbles') {
      return Boolean(surfaces.bluebubbles.enabled || surfaces.bluebubbles.serverUrl || surfaces.bluebubbles.defaultChatGuid || process.env.BLUEBUBBLES_SERVER_URL);
    }
    if (surface === 'mattermost') {
      return Boolean(surfaces.mattermost.enabled || surfaces.mattermost.baseUrl || surfaces.mattermost.defaultChannelId || process.env.MATTERMOST_BASE_URL);
    }
    return Boolean(surfaces.matrix.enabled || surfaces.matrix.homeserverUrl || surfaces.matrix.defaultRoomId || process.env.MATRIX_HOMESERVER);
  }

  private async pollPendingSurfaceReplies(): Promise<void> {
    if (this.pendingSurfaceReplies.size === 0) return;
    const completed: string[] = [];
    for (const pending of this.pendingSurfaceReplies.values()) {
      if (!this.channelReplyPipeline.has(pending.agentId)) {
        completed.push(pending.agentId);
        continue;
      }
      const record = this.agentManager.getStatus(pending.agentId);
      if (record && (record.status === 'pending' || record.status === 'running')) {
        const progress = record.progress ?? record.streamingContent;
        if (progress && progress !== pending.lastProgress && (Date.now() - (pending.lastProgressAt ?? 0)) >= 10_000) {
          try {
            await this.channelReplyPipeline.deliverProgress(pending.agentId, progress, true);
            pending.lastProgress = progress;
            pending.lastProgressAt = Date.now();
          } catch (error) {
            logger.debug('DaemonServer: progress delivery failed', {
              surface: pending.surfaceKind,
              agentId: pending.agentId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      if (!record || (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled')) {
        continue;
      }
      const body = record.status === 'completed'
        ? (record.fullOutput ?? record.streamingContent ?? record.progress ?? 'Completed')
        : record.error ?? record.status;
      const message = String(body);
      this.syncFinishedAgentTask(record);
      if (pending.sessionId) {
        await this.sessionBroker.completeAgent(pending.sessionId, pending.agentId, message, {
          status: record.status,
          routeId: pending.routeId,
        });
      }
      try {
        await this.channelReplyPipeline.deliverFinal(pending.agentId, message);
      } catch (error) {
        logger.warn('DaemonServer: surface reply delivery failed', {
          surface: pending.surfaceKind,
          agentId: pending.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      completed.push(pending.agentId);
    }
    for (const agentId of completed) {
      this.pendingSurfaceReplies.delete(agentId);
    }
  }

  private async deliverSurfaceProgress(pending: PendingSurfaceReply, progress: string): Promise<void> {
    if (pending.surfaceKind === 'slack') {
      const webhookUrl =
        await this.serviceRegistry.resolveSecret('slack', 'webhookUrl')
        ?? process.env.SLACK_WEBHOOK_URL;
      const botToken =
        await this.serviceRegistry.resolveSecret('slack', 'primary')
        ?? process.env.SLACK_BOT_TOKEN;
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.responseUrl) {
        await fetch(pending.responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            text: `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`,
          }),
        });
        return;
      }
      if (pending.channelId) {
        await slack.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
      return;
    }
    if (pending.surfaceKind === 'discord') {
      const webhookUrl =
        await this.serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await this.serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.applicationId && pending.interactionToken) {
        await discord.editOriginalResponse(pending.applicationId, pending.interactionToken, `Progress: ${progress.slice(0, 180)}`);
        return;
      }
      if (pending.channelId) {
        await discord.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
    }
  }

  private async deliverSlackAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl =
      await this.serviceRegistry.resolveSecret('slack', 'webhookUrl')
      ?? process.env.SLACK_WEBHOOK_URL;
    const botToken =
      await this.serviceRegistry.resolveSecret('slack', 'primary')
      ?? process.env.SLACK_BOT_TOKEN;
    const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.responseUrl) {
      await fetch(pending.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          blocks: slack.formatAgentResult(pending.agentId, pending.task, message),
        }),
      });
      return;
    }
    if (pending.channelId) {
      await slack.postMessage(pending.channelId, message, slack.formatAgentResult(pending.agentId, pending.task, message));
    }
  }

  private async deliverDiscordAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl =
      await this.serviceRegistry.resolveSecret('discord', 'webhookUrl')
      ?? process.env.DISCORD_WEBHOOK_URL;
    const botToken =
      await this.serviceRegistry.resolveSecret('discord', 'primary')
      ?? process.env.DISCORD_BOT_TOKEN;
    const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.applicationId && pending.interactionToken) {
      await discord.editOriginalResponse(
        pending.applicationId,
        pending.interactionToken,
        '',
        [discord.formatAgentResult(pending.agentId, pending.task, message)],
      );
      return;
    }
    if (pending.channelId) {
      await discord.postMessage(pending.channelId, message, [discord.formatAgentResult(pending.agentId, pending.task, message)]);
    }
  }

  private async deliverNtfyAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const baseUrl = String(this.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
    const token = await this.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
    const topic = pending.topic ?? String(this.configManager.get('surfaces.ntfy.topic') ?? '');
    if (!topic) return;
    const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
    const webBase = String(this.configManager.get('controlPlane.baseUrl') ?? this.configManager.get('web.publicBaseUrl') ?? '');
    const baseAction = webBase.replace(/\/+$/, '');
    await ntfy.publish(topic, message, {
      title: `Agent ${pending.agentId}`,
      ...(baseAction
        ? {
            click: `${baseAction}/api/control-plane/web`,
            actions: [
              `${pending.sessionId ? `view,Session,${baseAction}/api/control-plane/web?session=${encodeURIComponent(pending.sessionId)}` : `view,Control Plane,${baseAction}/api/control-plane/web`}`,
            ],
          }
        : {}),
    });
  }

  private async deliverWebhookAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const callbackUrl = pending.callbackUrl ?? String(this.configManager.get('surfaces.webhook.defaultTarget') ?? '');
    if (!callbackUrl) return;
    const validation = validatePublicWebhookUrl(callbackUrl);
    if (!validation.ok) {
      logger.warn('DaemonServer: refusing unsafe webhook callback URL', {
        agentId: pending.agentId,
        reason: validation.error,
      });
      return;
    }
    const timeoutMs = Number(this.configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
    const payload = {
      agentId: pending.agentId,
      sessionId: pending.sessionId ?? null,
      routeId: pending.routeId ?? null,
      task: pending.task,
      message,
      status: this.agentManager.getStatus(pending.agentId)?.status ?? 'completed',
      correlationId: pending.callbackCorrelationId ?? null,
      completedAt: Date.now(),
    };
    const body = JSON.stringify(payload);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (pending.callbackCorrelationId) {
      headers.set('X-Goodvibes-Correlation-Id', pending.callbackCorrelationId);
    }
    const secret = String(this.configManager.get('surfaces.webhook.secret') ?? '');
    if (secret && pending.callbackSignature === 'hmac-sha256') {
      headers.set('X-Goodvibes-Signature', this.signWebhookPayload(body, secret));
    } else if (secret && pending.callbackSignature === 'shared-secret') {
      headers.set('X-Goodvibes-Webhook-Secret', secret);
    }
    await fetch(validation.url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body,
    });
  }

  private async deliverSlackApprovalUpdate(approval: SharedApprovalRecord, binding: import('../automation/routes.ts').AutomationRouteBinding): Promise<void> {
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const webhookUrl =
      await this.serviceRegistry.resolveSecret('slack', 'webhookUrl')
      ?? process.env.SLACK_WEBHOOK_URL;
    const botToken =
      await this.serviceRegistry.resolveSecret('slack', 'primary')
      ?? process.env.SLACK_BOT_TOKEN;
    const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    const blocks = isPending
      ? [
          { type: 'section', text: { type: 'mrkdwn', text: `*Approval required* for \`${approval.request.tool}\`\n${summary}` } },
          {
            type: 'actions',
            elements: [
              { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `gv:approval:approve:${approval.id}` },
              { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: `gv:approval:deny:${approval.id}` },
              ...(webUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Open Console' }, url: webUrl }] : []),
            ],
          },
        ]
      : undefined;
    if (typeof binding.metadata.responseUrl === 'string' && binding.metadata.responseUrl.startsWith('https://')) {
      await fetch(binding.metadata.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          text: isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`,
          ...(blocks ? { blocks } : {}),
        }),
      }).catch(() => {});
      return;
    }
    if (binding.channelId) {
      await slack.postMessage(binding.channelId, isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`, blocks);
    }
  }

  private async deliverDiscordApprovalUpdate(approval: SharedApprovalRecord, binding: import('../automation/routes.ts').AutomationRouteBinding): Promise<void> {
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const webhookUrl =
      await this.serviceRegistry.resolveSecret('discord', 'webhookUrl')
      ?? process.env.DISCORD_WEBHOOK_URL;
    const botToken =
      await this.serviceRegistry.resolveSecret('discord', 'primary')
      ?? process.env.DISCORD_BOT_TOKEN;
    const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    const content = isPending
      ? `Approval required for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`
      : `Approval ${approval.status} for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`;
    const applicationId = typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined;
    const interactionToken = typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined;
    if (applicationId && interactionToken) {
      await discord.editOriginalResponse(applicationId, interactionToken, content).catch(() => {});
      return;
    }
    if (binding.channelId) {
      await discord.postMessage(binding.channelId, content).catch(() => {});
    }
  }

  private async deliverNtfyApprovalUpdate(approval: SharedApprovalRecord, binding: import('../automation/routes.ts').AutomationRouteBinding): Promise<void> {
    const topic = binding.channelId ?? binding.externalId;
    if (!topic) return;
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;
    const ntfy = new NtfyIntegration(
      String(this.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
      await this.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
    );
    await ntfy.publish(topic, `${isPending ? 'Approval required' : `Approval ${approval.status}`}: ${summary}`, {
      title: approval.request.tool,
      ...(webUrl ? { click: webUrl } : {}),
    }).catch(() => {});
  }

  private async deliverWebhookApprovalUpdate(approval: SharedApprovalRecord, binding: import('../automation/routes.ts').AutomationRouteBinding): Promise<void> {
    if (typeof binding.metadata.callbackUrl !== 'string') return;
    const validation = validatePublicWebhookUrl(binding.metadata.callbackUrl);
    if (!validation.ok) {
      logger.warn('DaemonServer: refusing unsafe webhook approval callback URL', {
        approvalId: approval.id,
        reason: validation.error,
      });
      return;
    }
    const payload = JSON.stringify({
      type: 'approval',
      approval,
      webUrl: this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId }) ?? null,
    });
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const secret = String(this.configManager.get('surfaces.webhook.secret') ?? '');
    if (secret) {
      headers.set('X-Goodvibes-Signature', this.signWebhookPayload(payload, secret));
    }
    await fetch(validation.url, {
      method: 'POST',
      headers,
      body: payload,
    }).catch(() => {});
  }

  private async notifyApprovalUpdate(approval: SharedApprovalRecord): Promise<void> {
    await this.sessionBroker.start();
    await this.routeBindings.start();
    const routeId = approval.routeId
      ?? this.sessionBroker.getSession(approval.sessionId ?? '')?.routeIds[0];
    if (!routeId) return;
    const binding = this.routeBindings.getBinding(routeId);
    if (!binding) return;
    if (binding.surfaceKind !== 'service') {
      const pluginDelivered = await this.channelPlugins.notifyApproval(binding.surfaceKind, approval, binding);
      if (pluginDelivered) {
        return;
      }
    }
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const isPending = approval.status === 'pending' || approval.status === 'claimed';
    const summary = approval.request.analysis.summary;

    if (binding.surfaceKind === 'slack') {
      const webhookUrl =
        await this.serviceRegistry.resolveSecret('slack', 'webhookUrl')
        ?? process.env.SLACK_WEBHOOK_URL;
      const botToken =
        await this.serviceRegistry.resolveSecret('slack', 'primary')
        ?? process.env.SLACK_BOT_TOKEN;
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const blocks = isPending
        ? [
            { type: 'section', text: { type: 'mrkdwn', text: `*Approval required* for \`${approval.request.tool}\`\n${summary}` } },
            {
              type: 'actions',
              elements: [
                { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `gv:approval:approve:${approval.id}` },
                { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: `gv:approval:deny:${approval.id}` },
                ...(webUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Open Console' }, url: webUrl }] : []),
              ],
            },
          ]
        : undefined;
      if (typeof binding.metadata.responseUrl === 'string' && binding.metadata.responseUrl.startsWith('https://')) {
        await fetch(binding.metadata.responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            text: isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`,
            ...(blocks ? { blocks } : {}),
          }),
        }).catch(() => {});
        return;
      }
      if (binding.channelId) {
        await slack.postMessage(binding.channelId, isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`, blocks);
      }
      return;
    }

    if (binding.surfaceKind === 'discord') {
      const webhookUrl =
        await this.serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await this.serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const content = isPending
        ? `Approval required for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`
        : `Approval ${approval.status} for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`;
      const applicationId = typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined;
      const interactionToken = typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined;
      if (applicationId && interactionToken) {
        await discord.editOriginalResponse(applicationId, interactionToken, content).catch(() => {});
        return;
      }
      if (binding.channelId) {
        await discord.postMessage(binding.channelId, content).catch(() => {});
      }
      return;
    }

    if (binding.surfaceKind === 'ntfy') {
      const topic = binding.channelId ?? binding.externalId;
      if (!topic) return;
      const ntfy = new NtfyIntegration(
        String(this.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
        await this.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
      );
      await ntfy.publish(topic, `${isPending ? 'Approval required' : `Approval ${approval.status}`}: ${summary}`, {
        title: approval.request.tool,
        ...(webUrl ? { click: webUrl } : {}),
      }).catch(() => {});
      return;
    }

    if (binding.surfaceKind === 'webhook' && typeof binding.metadata.callbackUrl === 'string') {
      const validation = validatePublicWebhookUrl(binding.metadata.callbackUrl);
      if (!validation.ok) {
        logger.warn('DaemonServer: refusing unsafe webhook approval callback URL', {
          approvalId: approval.id,
          reason: validation.error,
        });
        return;
      }
      const payload = JSON.stringify({
        type: 'approval',
        approval,
        webUrl: webUrl ?? null,
      });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      const secret = String(this.configManager.get('surfaces.webhook.secret') ?? '');
      if (secret) {
        headers.set('X-Goodvibes-Signature', this.signWebhookPayload(payload, secret));
      }
      await fetch(validation.url, {
        method: 'POST',
        headers,
        body: payload,
      }).catch(() => {});
    }
  }

  private controlPlaneWebUrl(input: { readonly approvalId?: string; readonly sessionId?: string }): string | undefined {
    const base = String(this.configManager.get('controlPlane.baseUrl') ?? this.configManager.get('web.publicBaseUrl') ?? '');
    if (!base) return undefined;
    const url = new URL(`${base.replace(/\/+$/, '')}/api/control-plane/web`);
    if (input.approvalId) url.searchParams.set('approval', input.approvalId);
    if (input.sessionId) url.searchParams.set('session', input.sessionId);
    if (this.authToken) url.searchParams.set('token', this.authToken);
    return url.toString();
  }

  private signWebhookPayload(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  private transportId(): string {
    return `daemon:http:${this.host}:${this.port}`;
  }

  private trustProxyEnabled(): boolean {
    return this.tlsState?.trustProxy ?? Boolean(this.configManager.get('controlPlane.trustProxy'));
  }

  private transportScheme(): 'http' | 'https' {
    return this.tlsState?.scheme ?? 'http';
  }

  private transportEndpoint(): string {
    return `${this.transportScheme()}://${this.host}:${this.port}`;
  }

  private emitterContext(): import('../runtime/emitters/index.ts').EmitterContext {
    return {
      sessionId: 'daemon-server',
      traceId: `daemon-server:${this.host}:${this.port}`,
      source: 'daemon-server',
    };
  }

  private emitTransportInitializing(): void {
    if (!this.runtimeBus) return;
    emitTransportInitializing(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      protocol: 'http-daemon',
    });
    void this.fireTransportHook('initializing', {
      transportId: this.transportId(),
      protocol: 'http-daemon',
    });
  }

  private emitTransportConnected(): void {
    if (!this.runtimeBus) return;
    emitTransportConnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
    void this.fireTransportHook('connected', {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
  }

  private emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.runtimeBus) return;
    emitTransportDisconnected(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
    void this.fireTransportHook('disconnected', {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
  }

  private emitTransportTerminalFailure(error: string): void {
    if (!this.runtimeBus) return;
    emitTransportTerminalFailure(this.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      error,
    });
    void this.fireTransportHook('failed', {
      transportId: this.transportId(),
      error,
    });
  }

  private async fireTransportHook(specific: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await getHookDispatcher().fire({
        path: `Lifecycle:transport:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'transport' as HookCategory,
        specific,
        sessionId: 'daemon-server',
        timestamp: Date.now(),
        payload,
      });
    } catch {
      // Transport hooks are best-effort and must not break daemon lifecycle.
    }
  }
}
