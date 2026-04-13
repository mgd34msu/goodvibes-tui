import type { AutomationSurfaceKind } from '../automation/types.ts';
import type { SharedSessionMessage, SharedSessionRecord } from './session-types.ts';
import type { SharedSessionInputRecord } from './session-intents.ts';

export interface SharedSessionStoreSnapshot extends Record<string, unknown> {
  readonly sessions: readonly SharedSessionRecord[];
  readonly messages: readonly SharedSessionMessage[];
  readonly inputs: readonly SharedSessionInputRecord[];
}

export type SharedSessionAgentStatus = {
  readonly id: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
};

export type SharedSessionAgentStatusProvider = {
  getStatus(agentId: string): SharedSessionAgentStatus | null | undefined;
};

export type SharedSessionMessageSender = {
  send(fromId: string, toId: string, content: string, options?: { kind?: 'directive' }): boolean;
};

export type SharedSessionEventPublisher = (event: string, payload: unknown) => void;

export function dedupeSessionSurfaceKinds(
  participants: readonly { readonly surfaceKind: AutomationSurfaceKind }[],
): AutomationSurfaceKind[] {
  return [...new Set(participants.map((participant) => participant.surfaceKind))];
}
