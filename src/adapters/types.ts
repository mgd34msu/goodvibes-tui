import type { AgentManager } from '../tools/agent/index.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { AutomationSurfaceKind } from '../automation/types.ts';
import type { ChannelConversationKind, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.ts';
import type { SharedSessionBroker } from '../control-plane/index.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';

export interface SurfaceControlCommand {
  readonly action: 'status' | 'cancel' | 'retry';
  readonly id: string;
}

export interface QueueSurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string;
}

export type TrySpawnAgentInput = Parameters<AgentManager['spawn']>[0];
export type TrySpawnAgentResult = AgentRecord | Response;
export type TrySpawnAgentFn = (
  input: TrySpawnAgentInput,
  logLabel: string,
  sessionId?: string,
) => TrySpawnAgentResult;

export interface SurfaceAdapterContext {
  readonly serviceRegistry: ServiceRegistry;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'slack' | 'discord' | 'ntfy'>;
    userId?: string;
    channelId?: string;
    groupId?: string;
    threadId?: string;
    workspaceId?: string;
    conversationKind?: ChannelConversationKind;
    hasAnyMention?: boolean;
    text?: string;
    controlCommand?: string;
    mentioned?: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<ChannelPolicyDecision>;
  readonly parseSurfaceControlCommand: (text: string) => SurfaceControlCommand | null;
  readonly performSurfaceControlCommand: (command: SurfaceControlCommand) => Promise<string>;
  readonly performInteractiveSurfaceAction: (
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
  ) => Promise<string>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: QueueSurfaceReplyInput,
  ) => void;
}

export interface GenericWebhookReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly callbackUrl?: string;
  readonly callbackCorrelationId?: string;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256';
}

export interface GenericWebhookAdapterContext {
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'webhook'>;
    userId?: string;
    channelId?: string;
    groupId?: string;
    threadId?: string;
    workspaceId?: string;
    conversationKind?: ChannelConversationKind;
    hasAnyMention?: boolean;
    text?: string;
    controlCommand?: string;
    mentioned?: boolean;
    metadata?: Record<string, unknown>;
  }) => Promise<ChannelPolicyDecision>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  readonly surfaceDeliveryEnabled: (surface: Extract<AutomationSurfaceKind, 'webhook'>) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly queueWebhookReply: (input: GenericWebhookReplyInput) => void;
}
