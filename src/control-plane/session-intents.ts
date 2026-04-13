import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { AutomationSurfaceKind } from '../automation/types.ts';
import type {
  ProviderFailurePolicy,
  ProviderRoutingSelection,
  UnresolvedModelPolicy,
} from '../automation/types.ts';
import type { ExecutionIntent } from '../runtime/execution-intents.ts';

export const SHARED_SESSION_INPUT_INTENTS = ['submit', 'steer', 'follow-up'] as const;
export const SHARED_SESSION_INPUT_STATES = ['queued', 'delivered', 'spawned', 'completed', 'cancelled', 'failed', 'rejected'] as const;

export type SharedSessionInputIntent = typeof SHARED_SESSION_INPUT_INTENTS[number];
export type SharedSessionInputState = typeof SHARED_SESSION_INPUT_STATES[number];

export interface SharedSessionHelperModelOverride {
  readonly providerId: string;
  readonly modelId: string;
}

export interface SharedSessionRoutingIntent {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerSelection?: ProviderRoutingSelection;
  readonly unresolvedModelPolicy?: UnresolvedModelPolicy;
  readonly providerFailurePolicy?: ProviderFailurePolicy;
  readonly fallbackModels?: readonly string[];
  readonly helperModel?: SharedSessionHelperModelOverride;
  readonly executionIntent?: ExecutionIntent;
  readonly tools?: readonly string[];
  readonly reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
}

export interface SharedSessionInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly intent: SharedSessionInputIntent;
  readonly state: SharedSessionInputState;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly routeId?: string;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly surfaceId?: string;
  readonly externalId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly activeAgentId?: string;
  readonly metadata: Record<string, unknown>;
  readonly routing?: SharedSessionRoutingIntent;
  readonly error?: string;
}

export interface SharedSessionContinuationRequest {
  readonly sessionId: string;
  readonly input: SharedSessionInputRecord;
  readonly task: string;
  readonly routeBinding?: AutomationRouteBinding;
}

export interface SharedSessionContinuationResult {
  readonly agentId: string;
}

export type SharedSessionContinuationRunner = (
  input: SharedSessionContinuationRequest,
) => SharedSessionContinuationResult | Promise<SharedSessionContinuationResult | null> | null;

export interface SharedSessionCompletion {
  readonly session: {
    readonly id: string;
    readonly activeAgentId?: string;
  };
  readonly continuedInput?: SharedSessionInputRecord;
  readonly continuedAgentId?: string;
}
