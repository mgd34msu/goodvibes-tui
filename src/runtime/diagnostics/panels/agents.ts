/**
 * Agents diagnostic panel data provider.
 *
 * Subscribes to agent lifecycle events via the RuntimeEventBus and maintains
 * a bounded buffer of AgentEntry records. Provides filtered snapshots
 * for the agents/cohorts diagnostics panel.
 *
 * Tracks state, ownership, blockers, and completion status for each agent.
 */
import type { RuntimeEventBus, EnvelopeListener } from '../../events/index.ts';
import type { AnyRuntimeEvent } from '../../events/domain-map.ts';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import {
  type AgentEntry,
  type AgentDiagnosticState,
  type DiagnosticFilter,
  type PanelConfig,
  DEFAULT_PANEL_CONFIG,
  applyFilter,
  appendBounded,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';

/** Internal mutable agent record for in-progress agents. */
interface MutableAgentRecord {
  agentId: string;
  taskId?: string;
  task: string;
  state: AgentDiagnosticState;
  spawnedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  blockedOnCallId?: string;
  blockedOnTool?: string;
  traceId: string;
  sessionId: string;
}

/**
 * AgentsPanel — diagnostic data provider for agent lifecycle telemetry.
 *
 * Active agents are tracked in a live map; terminal agents are moved
 * to the history buffer for filtering and display.
 */
export class AgentsPanel {
  private readonly _config: PanelConfig;
  private readonly _eventBus: RuntimeEventBus;
  /** Active agents keyed by agentId. */
  private readonly _active = new Map<string, MutableAgentRecord>();
  /** Completed agent history (oldest first). */
  private readonly _history: AgentEntry[] = [];
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
    this._unsub = this._eventBus.onDomain('agents', handler as EnvelopeListener);
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
      case 'AGENT_SPAWNING': {
        const evt = p as { type: 'AGENT_SPAWNING'; agentId: string; taskId?: string; task: string };
        this._active.set(evt.agentId, {
          agentId: evt.agentId,
          taskId: evt.taskId,
          task: evt.task,
          state: 'spawning',
          spawnedAt: envelope.ts,
          traceId,
          sessionId,
        });
        this._notify();
        break;
      }
      case 'AGENT_RUNNING': {
        const evt = p as { type: 'AGENT_RUNNING'; agentId: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'running';
          record.blockedOnCallId = undefined;
          record.blockedOnTool = undefined;
          this._notify();
        }
        break;
      }
      case 'AGENT_AWAITING_MESSAGE': {
        const evt = p as { type: 'AGENT_AWAITING_MESSAGE'; agentId: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'awaiting_message';
          this._notify();
        }
        break;
      }
      case 'AGENT_AWAITING_TOOL': {
        const evt = p as { type: 'AGENT_AWAITING_TOOL'; agentId: string; callId: string; tool: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'awaiting_tool';
          record.blockedOnCallId = evt.callId;
          record.blockedOnTool = evt.tool;
          this._notify();
        }
        break;
      }
      case 'AGENT_FINALIZING': {
        const evt = p as { type: 'AGENT_FINALIZING'; agentId: string };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'finalizing';
          this._notify();
        }
        break;
      }
      case 'AGENT_COMPLETED': {
        const evt = p as { type: 'AGENT_COMPLETED'; agentId: string; durationMs: number };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'completed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          this._finalize(record);
        }
        break;
      }
      case 'AGENT_FAILED': {
        const evt = p as { type: 'AGENT_FAILED'; agentId: string; error: string; durationMs: number };
        const record = this._active.get(evt.agentId);
        if (record) {
          record.state = 'failed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          record.error = evt.error;
          this._finalize(record);
        }
        break;
      }
      case 'AGENT_CANCELLED': {
        const evt = p as { type: 'AGENT_CANCELLED'; agentId: string; reason?: string };
        const record = this._active.get(evt.agentId);
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

  private _finalize(record: MutableAgentRecord): void {
    this._active.delete(record.agentId);
    const entry: AgentEntry = {
      agentId: record.agentId,
      taskId: record.taskId,
      task: record.task,
      state: record.state,
      spawnedAt: record.spawnedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      error: record.error,
      blockedOnCallId: record.blockedOnCallId,
      blockedOnTool: record.blockedOnTool,
      traceId: record.traceId,
      sessionId: record.sessionId,
    };
    appendBounded(this._history, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Return a filtered snapshot combining active agents and completed history.
   * Ordered most-recent first.
   *
   * @param filter - Optional filter to restrict entries.
   */
  public getSnapshot(filter?: DiagnosticFilter): AgentEntry[] {
    const activeEntries: AgentEntry[] = [];
    for (const record of this._active.values()) {
      activeEntries.push({
        agentId: record.agentId,
        taskId: record.taskId,
        task: record.task,
        state: record.state,
        spawnedAt: record.spawnedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        error: record.error,
        blockedOnCallId: record.blockedOnCallId,
        blockedOnTool: record.blockedOnTool,
        traceId: record.traceId,
        sessionId: record.sessionId,
      });
    }
    const combined: AgentEntry[] = [...this._history, ...activeEntries];
    return applyFilter(combined, filter, (e) => e.spawnedAt);
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
