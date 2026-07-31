/**
 * OpsPanel — diagnostic data provider for the Operator Control Plane.
 *
 * Subscribes to OPS_AUDIT events from the UI-facing ops event feed and maintains a
 * bounded buffer of intervention records for display
 * in the Ops panel.
 *
 * Controls are only shown when the OpsControlPlane reports the action is legal
 * (state machine allows it), satisfying requirement: "No illegal action appears in UI".
 */
import type { RuntimeEventEnvelope } from '@/runtime/index.ts';
import type { PanelConfig } from '@/runtime/index.ts';
import { DEFAULT_PANEL_CONFIG, appendBounded, applyFilter } from '@/runtime/index.ts';
import type { DiagnosticFilter } from '@/runtime/index.ts';
import type { OpsInterventionReason, OpsEvent } from '@/runtime/index.ts';
import type { UiEventFeed } from '@/runtime/index.ts';

// ---------------------------------------------------------------------------
// Audit entry
// ---------------------------------------------------------------------------

/**
 * Immutable audit record for a single operator intervention.
 */
export interface OpsAuditEntry {
  /** Monotonic sequence number. */
  readonly seq: number;
  /** Epoch ms when the intervention was recorded. */
  readonly ts: number;
  /** The action taken (e.g. 'task.cancel', 'agent.cancel'). */
  readonly action: string;
  /** The target task or agent ID. */
  readonly targetId: string;
  /** Whether this intervention targeted a task or an agent. */
  readonly targetKind: 'task' | 'agent';
  /** The reason code for the intervention. */
  readonly reason: OpsInterventionReason;
  /** Optional operator note. */
  readonly note?: string;
  /** Outcome of the intervention. */
  readonly outcome: 'success' | 'rejected' | 'error';
  /** Error message if outcome is not success. */
  readonly errorMessage?: string;
  /** Trace identifier from the event envelope. */
  readonly traceId: string;
  /** Session identifier from the event envelope. */
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// OpsPanel
// ---------------------------------------------------------------------------

/** Internal mutable record (same shape as immutable OpsAuditEntry). */
type MutableAuditRecord = {
  seq: number;
  ts: number;
  action: string;
  targetId: string;
  targetKind: 'task' | 'agent';
  reason: OpsInterventionReason;
  note?: string;
  outcome: 'success' | 'rejected' | 'error';
  errorMessage?: string;
  traceId: string;
  sessionId: string;
};

/** Type alias for the OPS_AUDIT event shape. */
type OpsAuditEvent = Extract<OpsEvent, { type: 'OPS_AUDIT' }>;

export class OpsPanel {
  private readonly _config: PanelConfig;
  private readonly _events: UiEventFeed<OpsEvent>;

  private readonly _audit: MutableAuditRecord[] = [];
  private _seq = 0;

  private readonly _subscribers = new Set<() => void>();
  private _unsub: (() => void) | null = null;

  public constructor(
    events: UiEventFeed<OpsEvent>,
    config: PanelConfig = DEFAULT_PANEL_CONFIG
  ) {
    this._config = config;
    this._events = events;
    this._start();
  }

  private _start(): void {
    this._unsub = this._events.onEnvelope('OPS_AUDIT', (envelope) => {
      this._handleAudit(envelope as RuntimeEventEnvelope<'OPS_AUDIT', OpsAuditEvent>);
    });
  }

  private _handleAudit(
    envelope: RuntimeEventEnvelope<'OPS_AUDIT', OpsAuditEvent>
  ): void {
    const payload = envelope.payload;

    const record: MutableAuditRecord = {
      seq: ++this._seq,
      ts: envelope.ts,
      action: payload.action,
      targetId: payload.targetId,
      targetKind: payload.targetKind,
      reason: payload.reason,
      note: payload.note,
      outcome: payload.outcome,
      errorMessage: payload.errorMessage,
      traceId: envelope.traceId ?? '',
      sessionId: envelope.sessionId ?? '',
    };

    appendBounded(this._audit, record, this._config.bufferLimit);
    this._notify();
  }

  /**
   * Returns a filtered snapshot of the audit log, most recent first.
   */
  public getSnapshot(filter?: DiagnosticFilter): OpsAuditEntry[] {
    const entries = this._audit.map((r) => ({ ...r }) as OpsAuditEntry);
    return applyFilter(entries, filter, (e) => e.ts);
  }

  /**
   * Subscribe to data changes. Returns an unsubscribe function.
   */
  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => { this._subscribers.delete(callback); };
  }

  /**
   * Dispose the panel, unsubscribing from the event bus.
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
        // Non-fatal — subscriber errors must not crash the panel
      }
    }
  }
}
