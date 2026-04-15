/**
 * Tasks diagnostic panel data provider.
 *
 * Subscribes to task lifecycle events via the RuntimeEventBus and maintains
 * a bounded buffer of TaskEntry records. Provides filtered snapshots
 * for the tasks diagnostics panel.
 *
 * Covers all task kinds: exec, agent, acp, scheduler, daemon, mcp, plugin, integration.
 */
import type { RuntimeEventBus, EnvelopeListener } from '../../events/index.ts';
import type { AnyRuntimeEvent } from '../../events/domain-map.ts';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import {
  type TaskEntry,
  type DiagnosticFilter,
  type PanelConfig,
  DEFAULT_PANEL_CONFIG,
  applyFilter,
  appendBounded,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';

/** Task state as tracked internally while a task is in progress. */
type MutableTaskState = TaskEntry['state'];

/** Internal mutable task record used while the task is in progress. */
interface MutableTaskRecord {
  taskId: string;
  agentId?: string;
  description: string;
  priority: number;
  state: MutableTaskState;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  progress?: number;
  progressMessage?: string;
  blockReason?: string;
  error?: string;
  traceId: string;
  sessionId: string;
}

/**
 * TasksPanel — diagnostic data provider for runtime task telemetry.
 *
 * Active tasks are tracked in a live map; terminal tasks are moved
 * to the history buffer for filtering and display.
 */
export class TasksPanel {
  private readonly _config: PanelConfig;
  private readonly _eventBus: RuntimeEventBus;
  /** Active tasks keyed by taskId. */
  private readonly _active = new Map<string, MutableTaskRecord>();
  /** Completed task history (oldest first). */
  private readonly _history: TaskEntry[] = [];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function from the event bus. */
  private _unsub: (() => void) | null = null;

  constructor(eventBus: RuntimeEventBus, config: PanelConfig = DEFAULT_PANEL_CONFIG) {
    this._eventBus = eventBus;
    this._config = config;
    this._start();
  }

  private _start(): void {
    const handler: EnvelopeListener<AnyRuntimeEvent> = (
      envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
    ) => {
      this._handleEnvelope(envelope);
    };
    this._unsub = this._eventBus.onDomain('tasks', handler as EnvelopeListener);
  }

  private _handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const p = envelope.payload;
    if (!('type' in p)) return;
    const type = (p as { type: string }).type;
    const traceId = envelope.traceId;
    const sessionId = envelope.sessionId;

    switch (type) {
      case 'TASK_CREATED': {
        const evt = p as { type: 'TASK_CREATED'; taskId: string; agentId?: string; description: string; priority: number };
        this._active.set(evt.taskId, {
          taskId: evt.taskId,
          agentId: evt.agentId,
          description: evt.description,
          priority: evt.priority,
          state: 'created',
          createdAt: envelope.ts,
          traceId,
          sessionId,
        });
        this._notify();
        break;
      }
      case 'TASK_STARTED': {
        const evt = p as { type: 'TASK_STARTED'; taskId: string };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'running';
          this._notify();
        }
        break;
      }
      case 'TASK_BLOCKED': {
        const evt = p as { type: 'TASK_BLOCKED'; taskId: string; reason: string };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'blocked';
          record.blockReason = evt.reason;
          this._notify();
        }
        break;
      }
      case 'TASK_PROGRESS': {
        const evt = p as { type: 'TASK_PROGRESS'; taskId: string; progress: number; message?: string };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'progressing';
          record.progress = evt.progress;
          record.progressMessage = evt.message;
          this._notify();
        }
        break;
      }
      case 'TASK_COMPLETED': {
        const evt = p as { type: 'TASK_COMPLETED'; taskId: string; durationMs: number };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'completed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          this._finalize(record);
        }
        break;
      }
      case 'TASK_FAILED': {
        const evt = p as { type: 'TASK_FAILED'; taskId: string; error: string; durationMs: number };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'failed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          record.error = evt.error;
          this._finalize(record);
        }
        break;
      }
      case 'TASK_CANCELLED': {
        const evt = p as { type: 'TASK_CANCELLED'; taskId: string; reason?: string };
        const record = this._active.get(evt.taskId);
        if (record) {
          record.state = 'cancelled';
          record.completedAt = envelope.ts;
          record.error = evt.reason;
          this._finalize(record);
        }
        break;
      }
      default:
        break;
    }
  }

  private _finalize(record: MutableTaskRecord): void {
    this._active.delete(record.taskId);
    const entry: TaskEntry = {
      taskId: record.taskId,
      agentId: record.agentId,
      description: record.description,
      priority: record.priority,
      state: record.state,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      progress: record.progress,
      progressMessage: record.progressMessage,
      blockReason: record.blockReason,
      error: record.error,
      traceId: record.traceId,
      sessionId: record.sessionId,
    };
    appendBounded(this._history, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Return a filtered snapshot combining active tasks and completed history.
   * Ordered most-recent first.
   *
   * @param filter - Optional filter to restrict entries.
   */
  public getSnapshot(filter?: DiagnosticFilter): TaskEntry[] {
    const activeEntries: TaskEntry[] = [];
    for (const record of this._active.values()) {
      activeEntries.push({
        taskId: record.taskId,
        agentId: record.agentId,
        description: record.description,
        priority: record.priority,
        state: record.state,
        createdAt: record.createdAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        progress: record.progress,
        progressMessage: record.progressMessage,
        blockReason: record.blockReason,
        error: record.error,
        traceId: record.traceId,
        sessionId: record.sessionId,
      });
    }
    const combined: TaskEntry[] = [...this._history, ...activeEntries];
    return applyFilter(combined, filter, (e) => e.createdAt);
  }

  /**
   * Register a callback invoked whenever the data changes.
   * @returns An unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /**
   * Release all event bus subscriptions and clear internal state.
   */
  public dispose(): void {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    this._subscribers.clear();
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Non-fatal: subscriber errors must not crash the provider
      }
    }
  }
}
