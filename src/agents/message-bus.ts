// ---------------------------------------------------------------------------
// AgentMessageBus — real-time agent-to-agent communication
// ---------------------------------------------------------------------------

import { logger } from '../utils/logger.ts';

export interface AgentMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent ID, or 'system' for broadcasts from outside. */
  from: string;
  /** Recipient agent ID, or '*' for broadcasts. */
  to: string;
  /** Message content. */
  content: string;
  /** Unix timestamp (ms) when the message was created. */
  timestamp: number;
  /** Time-to-live in milliseconds. Default: 5 minutes. */
  ttlMs: number;
}

/** Callback type for message subscriptions. */
export type MessageCallback = (message: AgentMessage) => void;

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class AgentMessageBus {
  private static instance: AgentMessageBus | null = null;

  /** All messages keyed by recipient agent ID (or '*' for broadcasts). */
  private messages = new Map<string, AgentMessage[]>();

  /** Active subscriptions keyed by agent ID. */
  private subscriptions = new Map<string, Set<MessageCallback>>();

  /** Singleton accessor. */
  static getInstance(): AgentMessageBus {
    if (!AgentMessageBus.instance) {
      AgentMessageBus.instance = new AgentMessageBus();
    }
    return AgentMessageBus.instance;
  }

  /** Reset singleton — for testing only. */
  static resetInstance(): void {
    AgentMessageBus.instance = null;
  }

  /**
   * Send a message from one agent to another.
   * The message is stored for the recipient and delivered to any active subscribers.
   */
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

    this._store(toId, message);
    this._deliver(toId, message);
  }

  /**
   * Broadcast a message from one agent to all agents.
   * Stored under '*' and delivered to all active subscribers.
   */
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

    this._store('*', message);

    // Deliver to all current subscribers
    for (const [_agentId, callbacks] of this.subscriptions) {
      for (const cb of callbacks) {
        try {
          cb(message);
        } catch (err) {
          // never crash the bus on subscriber errors
          logger.debug('MessageBus: subscriber error in broadcast', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  /**
   * Subscribe to messages addressed to a specific agent.
   * Returns an unsubscribe function.
   */
  subscribe(agentId: string, callback: MessageCallback): () => void {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set());
    }
    this.subscriptions.get(agentId)!.add(callback);

    return () => {
      const set = this.subscriptions.get(agentId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.subscriptions.delete(agentId);
        }
      }
    };
  }

  /**
   * Get all non-expired messages for an agent (direct + broadcasts).
   */
  getMessages(agentId: string): AgentMessage[] {
    this.cleanup();
    const now = Date.now();
    const direct = (this.messages.get(agentId) ?? []).filter(
      (m) => now - m.timestamp < m.ttlMs,
    );
    const broadcasts = (this.messages.get('*') ?? []).filter(
      (m) => now - m.timestamp < m.ttlMs,
    );
    // Merge and sort by timestamp
    return [...direct, ...broadcasts].sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Remove all expired messages from all buckets.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, msgs] of this.messages) {
      const alive = msgs.filter((m) => now - m.timestamp < m.ttlMs);
      if (alive.length === 0) {
        this.messages.delete(key);
      } else {
        this.messages.set(key, alive);
      }
    }
  }

  /** Store a message in the bucket for a recipient. */
  private _store(recipientId: string, message: AgentMessage): void {
    if (!this.messages.has(recipientId)) {
      this.messages.set(recipientId, []);
    }
    this.messages.get(recipientId)!.push(message);
  }

  /** Deliver a message to active subscribers for a specific agent. */
  private _deliver(agentId: string, message: AgentMessage): void {
    const callbacks = this.subscriptions.get(agentId);
    if (!callbacks) return;
    for (const cb of callbacks) {
      try {
        cb(message);
      } catch (err) {
        // never crash the bus
        logger.debug('MessageBus: subscriber error in _deliver', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
