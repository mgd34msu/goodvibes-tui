import type { RuntimeEventDomain } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { ChannelSurface } from '@pellux/goodvibes-sdk/platform/channels/index';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation/index';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { GatewayMethodCatalog, GatewayMethodDescriptor } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type { RouteBindingManager, ChannelPolicyManager, ChannelPluginRegistry, ChannelReplyPipeline, ChannelProviderRuntimeManager, SurfaceRegistry, BuiltinChannelRuntime } from '@pellux/goodvibes-sdk/platform/channels/index';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { IntegrationHelperService } from '@pellux/goodvibes-sdk/platform/runtime/integration/helpers';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import type { DistributedRuntimeManager } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import type { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers/index';
import type { VoiceService } from '@pellux/goodvibes-sdk/platform/voice/index';
import type { WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search/index';
import type { KnowledgeGraphqlService, KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media/index';
import type { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal/index';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { AutomationExecutionPolicy, AutomationExternalContentSource, AutomationWakeMode } from '@pellux/goodvibes-sdk/platform/automation/index';
import type { AutomationJob } from '@pellux/goodvibes-sdk/platform/automation/jobs';
import type { SurfaceAdapterContext, GenericWebhookAdapterContext } from '@pellux/goodvibes-sdk/platform/adapters/index';
import type { SharedApprovalRecord } from '@pellux/goodvibes-sdk/platform/control-plane/index';
import type { DistributedPeerAuth } from '@pellux/goodvibes-sdk/platform/runtime/remote/index';
import type { HookCategory, HookEventPath, HookPhase } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type { RuntimeEventBus as EventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/index';

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
  readonly trySpawnAgent: (input: { mode: 'spawn'; task: string; model?: string; tools?: readonly string[]; provider?: string; context?: string }, logLabel: string, sessionId?: string) => import('@pellux/goodvibes-sdk/platform/tools/agent/index').AgentRecord | Response;
  readonly syncSpawnedAgentTask: (record: import('@pellux/goodvibes-sdk/platform/tools/agent/index').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('@pellux/goodvibes-sdk/platform/tools/agent/index').AgentRecord) => void;
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
