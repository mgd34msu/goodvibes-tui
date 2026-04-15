import type { RuntimeEventDomain } from '../runtime/events/index.ts';
import type { ChannelSurface } from '../channels/index.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type { AgentManager } from '../tools/agent/index.ts';
import type { AutomationDeliveryManager, AutomationManager } from '../automation/index.ts';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.ts';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '../control-plane/index.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { RouteBindingManager, ChannelPolicyManager, ChannelPluginRegistry, ChannelReplyPipeline, ChannelProviderRuntimeManager, SurfaceRegistry, BuiltinChannelRuntime } from '../channels/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { IntegrationHelperService } from '../runtime/integration/helpers.ts';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import type { DistributedRuntimeManager } from '../runtime/remote/index.ts';
import type { WatcherRegistry } from '../watchers/index.ts';
import type { VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';
import type { WebSearchService } from '../web-search/index.ts';
import type { KnowledgeGraphqlService, KnowledgeService } from '../knowledge/index.ts';
import type { MediaProviderRegistry } from '../media/index.ts';
import type { MultimodalService } from '../multimodal/index.ts';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { AutomationExecutionPolicy, AutomationExternalContentSource, AutomationWakeMode } from '../automation/index.ts';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { SurfaceAdapterContext, GenericWebhookAdapterContext } from '../adapters/index.ts';
import type { SharedApprovalRecord } from '../control-plane/index.ts';
import type { DistributedPeerAuth } from '../runtime/remote/index.ts';
import type { HookCategory, HookEventPath, HookPhase } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type { RuntimeEventBus as EventBus } from '../runtime/events/index.ts';
import type { EmitterContext } from '../runtime/emitters/index.ts';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../state/index.ts';

export interface DaemonConfig {
  port?: number;
  host?: string;
  workingDir?: string;
  homeDirectory?: string;
  configManager?: ConfigManager;
  githubWebhookSecret?: string;
  agentManager?: AgentManager;
  serveFactory?: typeof Bun.serve;
  userAuth?: UserAuthManager;
  runtimeBus?: RuntimeEventBus | null;
  runtimeServices?: RuntimeServices;
}

export interface DaemonDangerConfig {
  daemon: boolean;
}

export interface ControlPlaneWebSocketData {
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

export interface PendingSurfaceReply {
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

export interface DaemonRouteContext {
  readonly configManager: ConfigManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly automationManager: AutomationManager;
  readonly automationDeliveryManager: AutomationDeliveryManager;
  readonly approvalBroker: ApprovalBroker;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly providerRuntime: ChannelProviderRuntimeManager;
  readonly builtinChannels: BuiltinChannelRuntime;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly runtimeBus: EventBus | null;
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
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
  readonly githubWebhookSecret: string | null;
  readonly authToken: string | null;
  readonly host: string;
  readonly port: number;
  readonly tlsTrustProxy: boolean;
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly authorizeSurfaceIngress: (input: unknown) => Promise<unknown>;
  readonly extractAuthToken: (req: Request) => string;
  readonly checkAuth: (req: Request) => boolean;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly describeAuthenticatedPrincipal: (token: string) => { principalId: string; principalKind: 'user' | 'bot' | 'service' | 'token'; admin: boolean; scopes: readonly string[] } | null;
  readonly getGrantedGatewayScopes: (includeWrite: boolean) => readonly string[];
  readonly validateGatewayInvocation: (descriptor: GatewayMethodDescriptor, context?: { readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer'; readonly scopes?: readonly string[]; readonly admin?: boolean; }) => { status: number; ok: false; body: Record<string, unknown> } | null;
  readonly parseJsonBody: (req: Request) => Promise<Record<string, unknown> | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<Record<string, unknown> | null | Response>;
  readonly parseJsonText: (rawBody: string) => Record<string, unknown> | Response;
  readonly recordApiResponse: (req: Request, path: string, response: Response, clientKind?: 'web' | 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix' | 'daemon') => Response;
  readonly queueSurfaceReplyFromBinding: (binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding | undefined, input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; }) => void;
  readonly queueWebhookReply: (input: { readonly agentId: string; readonly task: string; readonly sessionId?: string; readonly routeId?: string; readonly callbackUrl?: string; readonly callbackCorrelationId?: string; readonly callbackSignature?: PendingSurfaceReply['callbackSignature']; }) => void;
  readonly parseSurfaceControlCommand: (text: string) => { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string } | null;
  readonly performSurfaceControlCommand: (command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string }) => Promise<string>;
  readonly performInteractiveSurfaceAction: (actionId: string, surface: 'slack' | 'discord', req: Request) => Promise<string>;
  readonly trySpawnAgent: (input: { mode: 'spawn'; task: string; model?: string; tools?: readonly string[]; provider?: string; context?: string }, logLabel: string, sessionId?: string) => import('../tools/agent/index.ts').AgentRecord | Response;
  readonly syncSpawnedAgentTask: (record: import('../tools/agent/index.ts').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../tools/agent/index.ts').AgentRecord) => void;
  readonly findSchedule: (id: string) => AutomationJob | undefined;
  readonly surfaceDeliveryEnabled: (surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix') => boolean;
  readonly pollPendingSurfaceReplies: () => Promise<void>;
  readonly deliverSurfaceProgress: (pending: PendingSurfaceReply, progress: string) => Promise<void>;
  readonly deliverSlackAgentReply: (pending: PendingSurfaceReply, message: string) => Promise<void>;
  readonly deliverDiscordAgentReply: (pending: PendingSurfaceReply, message: string) => Promise<void>;
  readonly deliverNtfyAgentReply: (pending: PendingSurfaceReply, message: string) => Promise<void>;
  readonly deliverWebhookAgentReply: (pending: PendingSurfaceReply, message: string) => Promise<void>;
  readonly deliverSlackApprovalUpdate: (approval: SharedApprovalRecord, binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding) => Promise<void>;
  readonly deliverDiscordApprovalUpdate: (approval: SharedApprovalRecord, binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding) => Promise<void>;
  readonly deliverNtfyApprovalUpdate: (approval: SharedApprovalRecord, binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding) => Promise<void>;
  readonly deliverWebhookApprovalUpdate: (approval: SharedApprovalRecord, binding: import('@pellux/goodvibes-sdk/platform/automation/routes').AutomationRouteBinding) => Promise<void>;
  readonly notifyApprovalUpdate: (approval: SharedApprovalRecord) => Promise<void>;
  readonly controlPlaneWebUrl: (input: { readonly approvalId?: string; readonly sessionId?: string }) => string | undefined;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly transportId: () => string;
  readonly transportScheme: () => 'http' | 'https';
  readonly transportEndpoint: () => string;
  readonly emitterContext: () => EmitterContext;
  readonly emitTransportInitializing: () => void;
  readonly emitTransportConnected: () => void;
  readonly emitTransportDisconnected: (reason: string, willRetry: boolean) => void;
  readonly emitTransportTerminalFailure: (error: string) => void;
  readonly fireTransportHook: (specific: string, payload: Record<string, unknown>) => Promise<void>;
}
