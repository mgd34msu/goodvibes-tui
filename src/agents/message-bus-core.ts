import { logger } from '../utils/logger.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import type { CommunicationKind, CommunicationScope } from '../runtime/events/communication.ts';
import { emitCommunicationBlocked, emitCommunicationDelivered, emitCommunicationSent } from '../runtime/emitters/index.ts';
import { summarizeError } from '../utils/error-display.ts';
import {
  communicationRoleForTemplate,
  evaluateCommunicationRoute,
  type AgentCommunicationMetadata,
} from './communication-policy.ts';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  ttlMs: number;
  kind: CommunicationKind;
  scope: CommunicationScope;
  fromRole?: string;
  toRole?: string;
  cohort?: string;
  wrfcId?: string;
  parentAgentId?: string;
}

export type MessageCallback = (message: AgentMessage) => void;

type MessageOptions = {
  ttlMs?: number;
  kind?: CommunicationKind;
  scope?: CommunicationScope;
  cohort?: string;
  wrfcId?: string;
  parentAgentId?: string;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class AgentMessageBus {
  private messages = new Map<string, AgentMessage[]>();
  private subscriptions = new Map<string, Set<MessageCallback>>();
  private identities = new Map<string, AgentCommunicationMetadata>([
    ['orchestrator', { agentId: 'orchestrator', role: 'orchestrator' }],
  ]);
  private runtimeBus: RuntimeEventBus | null = null;

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  registerAgent(meta: {
    agentId: string;
    template?: string;
    role?: AgentCommunicationMetadata['role'];
    parentAgentId?: string;
    cohort?: string;
    wrfcId?: string;
  }): void {
    this.identities.set(meta.agentId, {
      agentId: meta.agentId,
      role: meta.role ?? communicationRoleForTemplate(meta.template),
      ...(meta.parentAgentId !== undefined ? { parentAgentId: meta.parentAgentId } : {}),
      ...(meta.cohort !== undefined ? { cohort: meta.cohort } : {}),
      ...(meta.wrfcId !== undefined ? { wrfcId: meta.wrfcId } : {}),
    });
  }

  private resolveOptions(ttlOrOptions: number | MessageOptions | undefined): Required<Pick<MessageOptions, 'ttlMs' | 'kind' | 'scope'>> & Omit<MessageOptions, 'ttlMs' | 'kind' | 'scope'> {
    if (typeof ttlOrOptions === 'number') {
      return { ttlMs: ttlOrOptions, kind: 'directive', scope: 'direct' };
    }
    return {
      ttlMs: ttlOrOptions?.ttlMs ?? DEFAULT_TTL_MS,
      kind: ttlOrOptions?.kind ?? 'directive',
      scope: ttlOrOptions?.scope ?? 'direct',
      ...(ttlOrOptions?.cohort !== undefined ? { cohort: ttlOrOptions.cohort } : {}),
      ...(ttlOrOptions?.wrfcId !== undefined ? { wrfcId: ttlOrOptions.wrfcId } : {}),
      ...(ttlOrOptions?.parentAgentId !== undefined ? { parentAgentId: ttlOrOptions.parentAgentId } : {}),
    };
  }

  send(fromId: string, toId: string, content: string, ttlOrOptions: number | MessageOptions = DEFAULT_TTL_MS): boolean {
    this.cleanup();
    const options = this.resolveOptions(ttlOrOptions);
    const fromMeta = this.identities.get(fromId);
    const toMeta = this.identities.get(toId);

    if (fromMeta && toMeta) {
      const decision = evaluateCommunicationRoute({
        from: fromMeta,
        to: toMeta,
        kind: options.kind,
        scope: 'direct',
      });
      if (!decision.allowed) {
        const blockedId = crypto.randomUUID();
        this.emitBlocked(blockedId, fromId, toId, content, options, decision.reason ?? 'communication blocked by policy', fromMeta, toMeta);
        return false;
      }
    }

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromId,
      to: toId,
      content,
      timestamp: Date.now(),
      ttlMs: options.ttlMs,
      kind: options.kind,
      scope: 'direct',
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(toMeta?.role !== undefined ? { toRole: toMeta.role } : {}),
      ...(options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort ? { cohort: options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort } : {}),
      ...(options.wrfcId ?? fromMeta?.wrfcId ?? toMeta?.wrfcId ? { wrfcId: options.wrfcId ?? fromMeta?.wrfcId ?? toMeta?.wrfcId } : {}),
      ...(options.parentAgentId ?? fromMeta?.parentAgentId ? { parentAgentId: options.parentAgentId ?? fromMeta?.parentAgentId } : {}),
    };

    this.store(toId, message);
    this.deliver(toId, message);
    this.emitSent(message);
    this.emitDelivered(message);
    return true;
  }

  broadcast(fromId: string, content: string, ttlOrOptions: number | MessageOptions = DEFAULT_TTL_MS): boolean {
    this.cleanup();
    const options = this.resolveOptions(ttlOrOptions);
    const fromMeta = this.identities.get(fromId);
    if (fromMeta) {
      const decision = evaluateCommunicationRoute({
        from: fromMeta,
        to: { agentId: '*', role: 'general', ...(fromMeta.cohort !== undefined ? { cohort: fromMeta.cohort } : {}) },
        kind: options.kind,
        scope: 'broadcast',
      });
      if (!decision.allowed) {
        const blockedId = crypto.randomUUID();
        this.emitBlocked(blockedId, fromId, '*', content, { ...options, scope: 'broadcast' }, decision.reason ?? 'broadcast blocked by policy', fromMeta);
        return false;
      }
    }

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromId,
      to: '*',
      content,
      timestamp: Date.now(),
      ttlMs: options.ttlMs,
      kind: options.kind,
      scope: 'broadcast',
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(options.cohort ?? fromMeta?.cohort ? { cohort: options.cohort ?? fromMeta?.cohort } : {}),
      ...(options.wrfcId ?? fromMeta?.wrfcId ? { wrfcId: options.wrfcId ?? fromMeta?.wrfcId } : {}),
      ...(options.parentAgentId ?? fromMeta?.parentAgentId ? { parentAgentId: options.parentAgentId ?? fromMeta?.parentAgentId } : {}),
    };

    this.store('*', message);

    for (const callbacks of this.subscriptions.values()) {
      for (const callback of callbacks) {
        try {
          callback(message);
        } catch (error) {
          logger.debug('MessageBus: subscriber error in broadcast', {
            error: summarizeError(error),
          });
        }
      }
    }
    this.emitSent(message);
    this.emitDelivered(message);
    return true;
  }

  subscribe(agentId: string, callback: MessageCallback): () => void {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set());
    }
    this.subscriptions.get(agentId)!.add(callback);

    return () => {
      const callbacks = this.subscriptions.get(agentId);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscriptions.delete(agentId);
      }
    };
  }

  getMessages(agentId: string): AgentMessage[] {
    this.cleanup();
    const now = Date.now();
    const direct = (this.messages.get(agentId) ?? []).filter(
      (message) => now - message.timestamp < message.ttlMs,
    );
    const broadcasts = (this.messages.get('*') ?? []).filter(
      (message) => now - message.timestamp < message.ttlMs,
    );
    return [...direct, ...broadcasts].sort((a, b) => a.timestamp - b.timestamp);
  }

  private emitSent(message: AgentMessage): void {
    if (!this.runtimeBus) return;
    emitCommunicationSent(this.runtimeBus, {
      sessionId: 'agent-communication',
      traceId: `agent-communication:${message.id}:sent`,
      source: 'agent-message-bus',
    }, {
      messageId: message.id,
      fromId: message.from,
      toId: message.to,
      scope: message.scope,
      kind: message.kind,
      content: message.content,
      ...(message.fromRole !== undefined ? { fromRole: message.fromRole } : {}),
      ...(message.toRole !== undefined ? { toRole: message.toRole } : {}),
      ...(message.cohort !== undefined ? { cohort: message.cohort } : {}),
      ...(message.wrfcId !== undefined ? { wrfcId: message.wrfcId } : {}),
      ...(message.parentAgentId !== undefined ? { parentAgentId: message.parentAgentId } : {}),
    });
  }

  private emitDelivered(message: AgentMessage): void {
    if (!this.runtimeBus) return;
    emitCommunicationDelivered(this.runtimeBus, {
      sessionId: 'agent-communication',
      traceId: `agent-communication:${message.id}:delivered`,
      source: 'agent-message-bus',
    }, {
      messageId: message.id,
      fromId: message.from,
      toId: message.to,
      scope: message.scope,
      kind: message.kind,
    });
  }

  private emitBlocked(
    messageId: string,
    fromId: string,
    toId: string,
    content: string,
    options: Required<Pick<MessageOptions, 'ttlMs' | 'kind' | 'scope'>> & Omit<MessageOptions, 'ttlMs' | 'kind' | 'scope'>,
    reason: string,
    fromMeta?: AgentCommunicationMetadata,
    toMeta?: AgentCommunicationMetadata,
  ): void {
    if (!this.runtimeBus) return;
    emitCommunicationBlocked(this.runtimeBus, {
      sessionId: 'agent-communication',
      traceId: `agent-communication:${messageId}:blocked`,
      source: 'agent-message-bus',
    }, {
      messageId,
      fromId,
      toId,
      scope: options.scope,
      kind: options.kind,
      reason,
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(toMeta?.role !== undefined ? { toRole: toMeta.role } : {}),
      ...(options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort ? { cohort: options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort } : {}),
      ...(options.wrfcId ?? fromMeta?.wrfcId ?? toMeta?.wrfcId ? { wrfcId: options.wrfcId ?? fromMeta?.wrfcId ?? toMeta?.wrfcId } : {}),
      ...(options.parentAgentId ?? fromMeta?.parentAgentId ? { parentAgentId: options.parentAgentId ?? fromMeta?.parentAgentId } : {}),
    });
    logger.warn('MessageBus: communication blocked', {
      fromId,
      toId,
      kind: options.kind,
      scope: options.scope,
      reason,
      content,
    });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, messages] of this.messages) {
      const alive = messages.filter((message) => now - message.timestamp < message.ttlMs);
      if (alive.length === 0) {
        this.messages.delete(key);
        continue;
      }
      this.messages.set(key, alive);
    }
  }

  private store(recipientId: string, message: AgentMessage): void {
    if (!this.messages.has(recipientId)) {
      this.messages.set(recipientId, []);
    }
    this.messages.get(recipientId)!.push(message);
  }

  private deliver(agentId: string, message: AgentMessage): void {
    const callbacks = this.subscriptions.get(agentId);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(message);
      } catch (error) {
        logger.debug('MessageBus: subscriber error in deliver', {
          error: summarizeError(error),
        });
      }
    }
  }
}
