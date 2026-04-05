import { logger } from '../utils/logger.ts';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  ttlMs: number;
}

export type MessageCallback = (message: AgentMessage) => void;

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class AgentMessageBus {
  private static instance: AgentMessageBus | null = null;
  private messages = new Map<string, AgentMessage[]>();
  private subscriptions = new Map<string, Set<MessageCallback>>();

  static getInstance(): AgentMessageBus {
    if (!AgentMessageBus.instance) {
      AgentMessageBus.instance = new AgentMessageBus();
    }
    return AgentMessageBus.instance;
  }

  static resetInstance(): void {
    AgentMessageBus.instance = null;
  }

  send(fromId: string, toId: string, content: string, ttlMs = DEFAULT_TTL_MS): void {
    this.cleanup();

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromId,
      to: toId,
      content,
      timestamp: Date.now(),
      ttlMs,
    };

    this.store(toId, message);
    this.deliver(toId, message);
  }

  broadcast(fromId: string, content: string, ttlMs = DEFAULT_TTL_MS): void {
    this.cleanup();

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromId,
      to: '*',
      content,
      timestamp: Date.now(),
      ttlMs,
    };

    this.store('*', message);

    for (const callbacks of this.subscriptions.values()) {
      for (const callback of callbacks) {
        try {
          callback(message);
        } catch (error) {
          logger.debug('MessageBus: subscriber error in broadcast', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
