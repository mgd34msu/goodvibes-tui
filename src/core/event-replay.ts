import { randomUUID } from 'node:crypto';
import type { EventBus, EventMap } from './event-bus.ts';
import { logger } from '../utils/logger.ts';

export interface QueuedEvent {
  id: string;
  eventName: string;
  payload: unknown;
  timestamp: number;
  acknowledged: boolean;
  turnCount: number; // which LLM turn this was queued on
  replayCount: number; // how many times replayed
}

/** Events that are significant enough to track for replay. */
export const TRACKED_EVENTS = [
  'subagent:complete',
  'subagent:error',
  'wrfc:state-changed',
  'wrfc:chain-passed',
  'wrfc:chain-failed',
] as const;

function generateId(): string {
  return randomUUID();
}

/**
 * EventReplayQueue — holds events and replays unacknowledged ones.
 *
 * Grace period: events are held for 1 full LLM turn after they fire.
 * After the grace period, if unacknowledged, they are replayed as
 * system messages in the conversation.
 *
 * Replay strategy:
 * - After 1 turn grace: replay once as system message
 * - After 2nd replay: replay with emphasis
 * - After 3rd replay: mark as dropped, log warning
 * - Max 3 replays per event
 */
export class EventReplayQueue {
  private queue: QueuedEvent[] = [];
  private currentTurn = 0;
  private droppedCount = 0;

  constructor(
    private bus: EventBus,
    private maxReplays: number = 3,
    private graceTurns: number = 1,
  ) {}

  /**
   * Enqueue an event for tracking.
   * Called when significant events fire (agent complete, WRFC state change, etc.)
   * Returns the assigned event ID.
   */
  enqueue(eventName: string, payload: unknown): string {
    const id = generateId();
    this.queue.push({
      id,
      eventName,
      payload,
      timestamp: Date.now(),
      acknowledged: false,
      turnCount: this.currentTurn,
      replayCount: 0,
    });
    return id;
  }

  /**
   * Mark an event as acknowledged by ID.
   * Called when the model demonstrates awareness of the event.
   */
  acknowledge(eventId: string): void {
    const event = this.queue.find((e) => e.id === eventId);
    if (event) {
      event.acknowledged = true;
    }
  }

  /**
   * Acknowledge all events matching a predicate.
   * E.g., acknowledge all events for a specific agent ID.
   * Returns the number of events acknowledged.
   */
  acknowledgeWhere(predicate: (event: QueuedEvent) => boolean): number {
    let count = 0;
    for (const event of this.queue) {
      if (!event.acknowledged && predicate(event)) {
        event.acknowledged = true;
        count++;
      }
    }
    return count;
  }

  /**
   * Signal that an LLM turn has completed.
   * Increments the turn counter and returns events that need replaying.
   * Events that exceed maxReplays are dropped (logged and removed from queue).
   */
  onTurnComplete(): QueuedEvent[] {
    this.currentTurn++;

    const toReplay: QueuedEvent[] = [];
    const toRemove: string[] = [];

    for (const event of this.queue) {
      if (event.acknowledged) continue;

      const turnsElapsed = this.currentTurn - event.turnCount;
      if (turnsElapsed <= this.graceTurns) continue;

      if (event.replayCount >= this.maxReplays) {
        // Drop: exceeded max replays
        logger.debug(
          `[EventReplayQueue] Dropping event ${event.id} (${event.eventName}) after ${event.replayCount} replays — model did not acknowledge.`,
        );
        toRemove.push(event.id);
        this.droppedCount++;
      } else {
        event.replayCount++;
        toReplay.push(event);
      }
    }

    // Remove dropped events
    if (toRemove.length > 0) {
      const toRemoveSet = new Set(toRemove);
      this.queue = this.queue.filter((e) => !toRemoveSet.has(e.id));
    }

    return toReplay;
  }

  /**
   * Format replay events as system messages ready to inject into the conversation.
   */
  formatReplays(events: QueuedEvent[]): string[] {
    return events.map((event) => {
      const turnsAgo = this.currentTurn - event.turnCount;
      const base = this._formatEventMessage(event, turnsAgo);

      if (event.replayCount >= this.maxReplays) {
        return `[Replay][URGENT] ${base}`;
      } else if (event.replayCount >= Math.ceil(this.maxReplays * (2 / 3))) {
        return `[Replay][Action Required] ${base}`;
      }
      return `[Replay] ${base}`;
    });
  }

  /**
   * Get queue stats for telemetry and debugging.
   */
  getStats(): {
    queued: number;
    acknowledged: number;
    pending: number;
    replayed: number;
    dropped: number;
  } {
    const acknowledged = this.queue.filter((e) => e.acknowledged).length;
    const pending = this.queue.filter((e) => !e.acknowledged).length;
    const replayed = this.queue.filter((e) => e.replayCount > 0).length;

    return {
      queued: this.queue.length,
      acknowledged,
      pending,
      replayed,
      dropped: this.droppedCount,
    };
  }

  /**
   * Clear all events (e.g., on session reset).
   */
  clear(): void {
    this.queue = [];
    this.currentTurn = 0;
    this.droppedCount = 0;
  }

  /** Format a human-readable message for a single event. */
  private _formatEventMessage(event: QueuedEvent, turnsAgo: number): string {
    const turnWord = turnsAgo === 1 ? 'turn' : 'turns';
    const payload = event.payload as Record<string, unknown>;

    switch (event.eventName) {
      case 'subagent:complete': {
        const id = (payload?.id as string) ?? 'unknown';
        const task = (payload?.result as Record<string, unknown>)?.task as string | undefined;
        const taskStr = task ? ` task "${task}"` : '';
        return `Agent ${id} completed${taskStr} (first notified ${turnsAgo} ${turnWord} ago)`;
      }
      case 'subagent:error': {
        const id = (payload?.id as string) ?? 'unknown';
        const err = payload?.error as Error | undefined;
        const errStr = err?.message ? `: ${err.message}` : '';
        return `Agent ${id} failed${errStr} (first notified ${turnsAgo} ${turnWord} ago)`;
      }
      case 'wrfc:state-changed': {
        const chainId = (payload?.chainId as string) ?? 'unknown';
        const from = (payload?.from as string) ?? '?';
        const to = (payload?.to as string) ?? '?';
        return `WRFC chain ${chainId} transitioned ${from} \u2192 ${to} — waiting for action (first notified ${turnsAgo} ${turnWord} ago)`;
      }
      case 'wrfc:chain-passed': {
        const chainId = (payload?.chainId as string) ?? 'unknown';
        return `WRFC chain ${chainId} passed — waiting for action (first notified ${turnsAgo} ${turnWord} ago)`;
      }
      case 'wrfc:chain-failed': {
        const chainId = (payload?.chainId as string) ?? 'unknown';
        const reason = (payload?.reason as string) ?? 'unknown reason';
        return `WRFC chain ${chainId} failed: ${reason} — waiting for action (first notified ${turnsAgo} ${turnWord} ago)`;
      }
      default: {
        return `Event ${event.eventName} (id: ${event.id}) fired ${turnsAgo} ${turnWord} ago — waiting for acknowledgment`;
      }
    }
  }

  /**
   * Wire up listeners for all tracked events on the provided bus.
   * Returns an unsubscribe function that removes all listeners.
   */
  static attachTo(bus: EventBus, queue: EventReplayQueue): () => void {
    const unsubs: Array<() => void> = [];

    for (const eventName of TRACKED_EVENTS) {
      // TRACKED_EVENTS values are a strict subset of EventMap keys; cast is sound.
      const key = eventName as keyof EventMap;
      const unsub = bus.on(key, ((payload: unknown) => {
        queue.enqueue(eventName, payload);
      }) as Parameters<EventBus['on']>[1]);
      unsubs.push(unsub);
    }

    return () => unsubs.forEach((u) => u());
  }
}
