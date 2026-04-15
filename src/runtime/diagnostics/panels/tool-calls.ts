/**
 * Tool Calls diagnostic panel data provider.
 *
 * Subscribes to tool lifecycle events via the RuntimeEventBus and maintains
 * a bounded buffer of ToolCallEntry records. Provides filtered snapshots
 * for the tool-calls diagnostics panel.
 *
 * Phase timeline tracking allows the panel to render latency breakdowns
 * and highlight failures at any lifecycle phase.
 */
import type { RuntimeEventBus, EnvelopeListener } from '../../events/index.ts';
import type { AnyRuntimeEvent } from '../../events/domain-map.ts';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import {
  type ToolCallEntry,
  type ToolCallPhase,
  type DiagnosticFilter,
  type PanelConfig,
  DEFAULT_PANEL_CONFIG,
  applyFilter,
  appendBounded,
} from '@pellux/goodvibes-sdk/platform/runtime/diagnostics/types';

/** Internal mutable tool call record used while the call is in progress. */
interface MutableToolCallRecord {
  callId: string;
  turnId: string;
  tool: string;
  args: Record<string, unknown>;
  phase: ToolCallPhase;
  receivedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  cancelReason?: string;
  permissionApproved?: boolean;
  traceId: string;
  sessionId: string;
}

/**
 * ToolCallsPanel — diagnostic data provider for tool call telemetry.
 *
 * Listens to all tool domain events and builds a per-call timeline.
 * Completed calls are transferred to a bounded history buffer.
 */
export class ToolCallsPanel {
  private readonly _config: PanelConfig;
  private readonly _eventBus: RuntimeEventBus;
  /** Active calls keyed by callId. */
  private readonly _active = new Map<string, MutableToolCallRecord>();
  /** Completed call history (oldest first). */
  private readonly _history: ToolCallEntry[] = [];
  /** Registered change notification callbacks. */
  private readonly _subscribers = new Set<() => void>();
  /** Unsubscribe function returned by the event bus. */
  private _unsub: (() => void) | null = null;

  constructor(eventBus: RuntimeEventBus, config: PanelConfig = DEFAULT_PANEL_CONFIG) {
    this._eventBus = eventBus;
    this._config = config;
    this._start();
  }

  /**
   * Subscribe to the tool domain and wire up event handlers.
   * @internal
   */
  private _start(): void {
    const handler: EnvelopeListener<AnyRuntimeEvent> = (
      envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
    ) => {
      this._handleEnvelope(envelope);
    };
    this._unsub = this._eventBus.onDomain('tools', handler as EnvelopeListener);
  }

  /**
   * Handle a tool domain envelope, routing to the appropriate update method.
   */
  private _handleEnvelope(
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const p = envelope.payload;
    // Type narrowing is done by checking the discriminant field on payload.
    if (!('type' in p)) return;
    const type = (p as { type: string }).type;
    const traceId = envelope.traceId;
    const sessionId = envelope.sessionId;

    switch (type) {
      case 'TOOL_RECEIVED': {
        const evt = p as { type: 'TOOL_RECEIVED'; callId: string; turnId: string; tool: string; args: Record<string, unknown> };
        this._active.set(evt.callId, {
          callId: evt.callId,
          turnId: evt.turnId,
          tool: evt.tool,
          args: evt.args,
          phase: 'received',
          receivedAt: envelope.ts,
          traceId,
          sessionId,
        });
        this._notify();
        break;
      }
      case 'TOOL_VALIDATED':
      case 'TOOL_PREHOOKED':
      case 'TOOL_EXECUTING':
      case 'TOOL_MAPPED':
      case 'TOOL_POSTHOOKED': {
        const evt = p as { type: string; callId: string };
        const phaseMap: Record<string, ToolCallPhase> = {
          TOOL_VALIDATED: 'validated',
          TOOL_PREHOOKED: 'prehooked',
          TOOL_EXECUTING: 'executing',
          TOOL_MAPPED: 'mapped',
          TOOL_POSTHOOKED: 'posthooked',
        };
        const record = this._active.get(evt.callId);
        if (record) {
          record.phase = phaseMap[type]!;
          this._notify();
        }
        break;
      }
      case 'TOOL_PERMISSIONED': {
        const evt = p as { type: 'TOOL_PERMISSIONED'; callId: string; approved: boolean };
        const record = this._active.get(evt.callId);
        if (record) {
          record.phase = 'permissioned';
          record.permissionApproved = evt.approved;
          this._notify();
        }
        break;
      }
      case 'TOOL_SUCCEEDED': {
        const evt = p as { type: 'TOOL_SUCCEEDED'; callId: string; durationMs: number };
        const record = this._active.get(evt.callId);
        if (record) {
          record.phase = 'succeeded';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          this._finalize(record);
        }
        break;
      }
      case 'TOOL_FAILED': {
        const evt = p as { type: 'TOOL_FAILED'; callId: string; error: string; durationMs: number };
        const record = this._active.get(evt.callId);
        if (record) {
          record.phase = 'failed';
          record.completedAt = envelope.ts;
          record.durationMs = evt.durationMs;
          record.error = evt.error;
          this._finalize(record);
        }
        break;
      }
      case 'TOOL_CANCELLED': {
        const evt = p as { type: 'TOOL_CANCELLED'; callId: string; reason?: string };
        const record = this._active.get(evt.callId);
        if (record) {
          record.phase = 'cancelled';
          record.completedAt = envelope.ts;
          record.cancelReason = evt.reason;
          this._finalize(record);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Move a completed record from active to history.
   */
  private _finalize(record: MutableToolCallRecord): void {
    this._active.delete(record.callId);
    const entry: ToolCallEntry = {
      callId: record.callId,
      turnId: record.turnId,
      tool: record.tool,
      args: record.args,
      phase: record.phase,
      receivedAt: record.receivedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      error: record.error,
      cancelReason: record.cancelReason,
      permission: record.permissionApproved !== undefined
        ? { approved: record.permissionApproved }
        : undefined,
      traceId: record.traceId,
      sessionId: record.sessionId,
    };
    appendBounded(this._history, entry, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Return a filtered snapshot of tool call entries.
   * Active calls are included as their current in-progress state.
   * History is ordered most-recent first.
   *
   * @param filter - Optional filter to restrict entries.
   */
  public getSnapshot(filter?: DiagnosticFilter): ToolCallEntry[] {
    // Convert active records to ToolCallEntry for inclusion
    const activeEntries: ToolCallEntry[] = [];
    for (const record of this._active.values()) {
      activeEntries.push({
        callId: record.callId,
        turnId: record.turnId,
        tool: record.tool,
        args: record.args,
        phase: record.phase,
        receivedAt: record.receivedAt,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        error: record.error,
        cancelReason: record.cancelReason,
        permission: record.permissionApproved !== undefined
          ? { approved: record.permissionApproved }
          : undefined,
        traceId: record.traceId,
        sessionId: record.sessionId,
      });
    }

    // Combine: history (oldest-first) + active, then apply filter
    const combined: ToolCallEntry[] = [...this._history, ...activeEntries];
    return applyFilter(combined, filter, (e) => e.receivedAt);
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
   * After disposal the panel will no longer receive new events.
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
