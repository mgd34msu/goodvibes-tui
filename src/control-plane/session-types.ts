import type { AutomationRouteBinding } from '../automation/routes.ts';
import type { AutomationSurfaceKind } from '../automation/types.ts';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionRoutingIntent,
} from './session-intents.ts';

export type SharedSessionStatus = 'active' | 'closed';
export type SharedSessionMessageRole = 'user' | 'assistant' | 'system';

export interface SharedSessionParticipant {
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly routeId?: string;
  readonly lastSeenAt: number;
}

export interface SharedSessionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: SharedSessionMessageRole;
  readonly body: string;
  readonly createdAt: number;
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly surfaceId?: string;
  readonly routeId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly metadata: Record<string, unknown>;
}

export interface SharedSessionRecord {
  readonly id: string;
  readonly title: string;
  readonly status: SharedSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastMessageAt?: number;
  readonly closedAt?: number;
  readonly messageCount: number;
  readonly pendingInputCount: number;
  readonly routeIds: readonly string[];
  readonly surfaceKinds: readonly AutomationSurfaceKind[];
  readonly participants: readonly SharedSessionParticipant[];
  readonly activeAgentId?: string;
  readonly lastAgentId?: string;
  readonly lastError?: string;
  readonly metadata: Record<string, unknown>;
}

export interface SharedSessionSubmission {
  readonly session: SharedSessionRecord;
  readonly userMessage: SharedSessionMessage;
  readonly routeBinding?: AutomationRouteBinding;
  readonly input: SharedSessionInputRecord;
  readonly intent: SharedSessionInputIntent;
  readonly mode: 'spawn' | 'continued-live' | 'queued-follow-up' | 'rejected';
  readonly state: SharedSessionInputRecord['state'];
  readonly task?: string;
  readonly activeAgentId?: string;
  readonly created: boolean;
}

export interface SubmitSharedSessionMessageInput {
  readonly sessionId?: string;
  readonly routeId?: string;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string;
  readonly threadId?: string;
  readonly userId?: string;
  readonly displayName?: string;
  readonly title?: string;
  readonly body: string;
  readonly metadata?: Record<string, unknown>;
  readonly routing?: SharedSessionRoutingIntent;
}

export interface SteerSharedSessionMessageInput extends SubmitSharedSessionMessageInput {
  readonly allowSpawnFallback?: boolean;
}

export interface FindSharedSessionOptions {
  readonly surfaceKind?: AutomationSurfaceKind;
  readonly routeId?: string;
  readonly includeClosed?: boolean;
}
