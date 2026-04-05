/**
 * ForensicsCollector — subscribes to the RuntimeEventBus and automatically
 * generates FailureReport objects when tasks or turns reach terminal failure
 * states.
 *
 * Integration points:
 * - 'tasks' domain: TASK_FAILED, TASK_CANCELLED
 * - 'turn' domain: TURN_ERROR, TURN_CANCEL
 * - 'tools' domain: tool failures (permission denial, execution failure)
 * - Health cascade events from the ops/session domain
 *
 * Reports are pushed to the ForensicsRegistry and a FORENSICS_REPORT_CREATED
 * event is emitted so the panel can refresh.
 */
import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.ts';
import { createEventEnvelope } from '../events/index.ts';
import type { AnyRuntimeEvent } from '../events/domain-map.ts';
import type {
  FailureReport,
  PhaseTimingEntry,
  PhaseLedgerEntry,
  PhaseLedgerOutcome,
  CausalChainEntry,
  ForensicsJumpLink,
  PermissionEvidenceEntry,
  BudgetBreachEvidence,
} from './types.ts';
import { classifyFailure, summariseFailure } from './classifier.ts';
import type { ForensicsRegistry } from './registry.ts';
import { emitForensicsReportCreated } from '../emitters/forensics.ts';

// ---------------------------------------------------------------------------
// Internal turn/task tracking
// ---------------------------------------------------------------------------

/** Maximum orphaned trackers retained before evicting oldest entries. */
const MAX_TRACKER_SIZE = 500;

/** Mutable state accumulated while a turn is in flight. */
interface TurnTracker {
  readonly turnId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly startedAt: number;
  /** Phase timings accumulated as turn events arrive. */
  readonly phaseTimings: PhaseTimingEntry[];
  /** Explicit ordered phase transition ledger. */
  readonly phaseLedger: PhaseLedgerEntry[];
  /** Causal chain entries (tool failures, permission denials, cascade). */
  readonly causalChain: CausalChainEntry[];
  /** Cascade events observed for this turn. */
  readonly cascadeEvents: CausalChainEntry[];
  /** Permission evidence correlated through tool call ids. */
  readonly permissionEvidence: PermissionEvidenceEntry[];
  /** Budget/timeout breaches observed during tool execution. */
  readonly budgetBreaches: BudgetBreachEvidence[];
  hasToolFailure: boolean;
  hasPermissionDenial: boolean;
  hasCascadeEvents: boolean;
  hasCompactionError: boolean;
  lastPhaseStart?: number;
  currentPhase?: string;
  currentPhaseEnterEventType?: string;
  _causalSeq: number;
  _phaseSeq: number;
}

/** Mutable state accumulated while a task is in flight. */
interface TaskTracker {
  readonly taskId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly startedAt: number;
  readonly phaseTimings: PhaseTimingEntry[];
  readonly phaseLedger: PhaseLedgerEntry[];
  readonly causalChain: CausalChainEntry[];
  readonly cascadeEvents: CausalChainEntry[];
  readonly permissionEvidence: PermissionEvidenceEntry[];
  readonly budgetBreaches: BudgetBreachEvidence[];
  agentId?: string;
  hasToolFailure: boolean;
  hasPermissionDenial: boolean;
  hasCascadeEvents: boolean;
  hasCompactionError: boolean;
  currentPhase?: string;
  lastPhaseStart?: number;
  currentPhaseEnterEventType?: string;
  _causalSeq: number;
  _phaseSeq: number;
}

// ---------------------------------------------------------------------------
// ForensicsCollector
// ---------------------------------------------------------------------------

export class ForensicsCollector {
  private readonly _bus: RuntimeEventBus;
  private readonly _registry: ForensicsRegistry;
  private readonly _unsubs: Array<() => void> = [];

  /** Active turn trackers keyed by turnId. */
  private readonly _turns = new Map<string, TurnTracker>();
  /** Active task trackers keyed by taskId. */
  private readonly _tasks = new Map<string, TaskTracker>();
  /** Correlation map from tool call id to owning turn id. */
  private readonly _callToTurn = new Map<string, string>();

  public constructor(bus: RuntimeEventBus, registry: ForensicsRegistry) {
    this._bus = bus;
    this._registry = registry;
    this._start();
  }

  private _start(): void {
    // Subscribe to turn domain
    this._unsubs.push(
      this._bus.onDomain('turn', (env) => this._handleTurnEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>))
    );
    // Subscribe to tasks domain
    this._unsubs.push(
      this._bus.onDomain('tasks', (env) => this._handleTaskEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>))
    );
    // Subscribe to tools domain for permission/failure context
    this._unsubs.push(
      this._bus.onDomain('tools', (env) => this._handleToolEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>))
    );
    this._unsubs.push(
      this._bus.onDomain('permissions', (env) => this._handlePermissionEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>))
    );
    // Subscribe to session domain for cascade/compaction events
    this._unsubs.push(
      this._bus.onDomain('compaction', (env) => this._handleCompactionEnvelope(env as RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>))
    );
  }

  // ── Turn handling ──────────────────────────────────────────────────────────

  private _handleTurnEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as { type: string; turnId?: string; reason?: string; error?: string; response?: string; content?: string; toolCalls?: unknown[]; accumulated?: string; prompt?: string; stopReason?: string };
    const turnId = payload.turnId;
    if (!turnId) return;

    switch (payload.type) {
      case 'TURN_SUBMITTED': {
        // Evict oldest orphaned tracker if at cap
        if (this._turns.size >= MAX_TRACKER_SIZE) {
          const firstKey = this._turns.keys().next().value;
          if (firstKey !== undefined) this._turns.delete(firstKey);
        }
        this._turns.set(turnId, {
          turnId,
          sessionId: env.sessionId,
          traceId: env.traceId,
          startedAt: env.ts,
          phaseTimings: [],
          phaseLedger: [],
          causalChain: [],
          cascadeEvents: [],
          permissionEvidence: [],
          budgetBreaches: [],
          hasToolFailure: false,
          hasPermissionDenial: false,
          hasCascadeEvents: false,
          hasCompactionError: false,
          currentPhase: 'SUBMITTED',
          lastPhaseStart: env.ts,
          currentPhaseEnterEventType: payload.type,
          _causalSeq: 0,
          _phaseSeq: 0,
        });
        break;
      }
      case 'PREFLIGHT_OK': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'PREFLIGHT', env.ts, payload.type);
        break;
      }
      case 'PREFLIGHT_FAIL': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'failed', payload.type, payload.reason);
        this._addCausal(t, env.ts, `Preflight failed: ${payload.reason ?? 'unknown reason'}`, payload.type, true);
        this._finalise_turn(t, payload.stopReason ?? payload.reason, payload.reason ?? 'Preflight failed', false);
        this._turns.delete(turnId);
        break;
      }
      case 'STREAM_START': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'STREAM', env.ts, payload.type);
        break;
      }
      case 'STREAM_END': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'STREAM_COMPLETE', env.ts, payload.type);
        break;
      }
      case 'TOOL_BATCH_READY': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'TOOL_BATCH', env.ts, payload.type);
        break;
      }
      case 'TOOLS_DONE': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'POST_TOOL_BATCH', env.ts, payload.type);
        break;
      }
      case 'POST_HOOKS_DONE': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._transitionPhase(t, 'turn', 'POST_HOOKS', env.ts, payload.type);
        break;
      }
      case 'TURN_COMPLETED': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'succeeded', payload.type);
        this._turns.delete(turnId);
        break;
      }
      case 'TURN_ERROR': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'failed', payload.type, payload.error);
        this._addCausal(t, env.ts, `Turn error: ${payload.error ?? 'unknown error'}`, payload.type, true);
        this._finalise_turn(t, payload.stopReason, payload.error, false);
        this._turns.delete(turnId);
        break;
      }
      case 'TURN_CANCEL': {
        const t = this._turns.get(turnId);
        if (!t) break;
        this._closePhase(t, 'turn', env.ts, 'cancelled', payload.type, payload.reason);
        this._addCausal(t, env.ts, `Turn cancelled: ${payload.reason ?? 'no reason given'}`, payload.type, false);
        this._finalise_turn(t, payload.stopReason ?? payload.reason, payload.reason, true);
        this._turns.delete(turnId);
        break;
      }
    }
  }

  // ── Task handling ──────────────────────────────────────────────────────────

  private _handleTaskEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as { type: string; taskId?: string; agentId?: string; error?: string; reason?: string; description?: string; priority?: number; durationMs?: number; progress?: number; message?: string };
    const taskId = payload.taskId;
    if (!taskId) return;

    switch (payload.type) {
      case 'TASK_CREATED': {
        // Evict oldest orphaned tracker if at cap
        if (this._tasks.size >= MAX_TRACKER_SIZE) {
          const firstKey = this._tasks.keys().next().value;
          if (firstKey !== undefined) this._tasks.delete(firstKey);
        }
        this._tasks.set(taskId, {
          taskId,
          sessionId: env.sessionId,
          traceId: env.traceId,
          startedAt: env.ts,
          phaseTimings: [],
          phaseLedger: [],
          causalChain: [],
          cascadeEvents: [],
          permissionEvidence: [],
          budgetBreaches: [],
          agentId: payload.agentId,
          hasToolFailure: false,
          hasPermissionDenial: false,
          hasCascadeEvents: false,
          hasCompactionError: false,
          currentPhase: 'CREATED',
          lastPhaseStart: env.ts,
          currentPhaseEnterEventType: payload.type,
          _causalSeq: 0,
          _phaseSeq: 0,
        });
        break;
      }
      case 'TASK_STARTED': {
        const task = this._tasks.get(taskId);
        if (task && payload.agentId) {
          (task as { agentId?: string }).agentId = payload.agentId;
        }
        if (task) {
          this._transitionPhase(task, 'task', 'RUNNING', env.ts, payload.type);
        }
        break;
      }
      case 'TASK_FAILED': {
        const task = this._tasks.get(taskId);
        if (!task) break;
        this._closePhase(task, 'task', env.ts, 'failed', payload.type, payload.error);
        this._addCausal(task, env.ts, `Task failed: ${payload.error ?? 'unknown error'}`, payload.type, true);
        this._finalise_task(task, payload.error, false);
        this._tasks.delete(taskId);
        break;
      }
      case 'TASK_CANCELLED': {
        const task = this._tasks.get(taskId);
        if (!task) break;
        this._closePhase(task, 'task', env.ts, 'cancelled', payload.type, payload.reason);
        this._addCausal(task, env.ts, `Task cancelled: ${payload.reason ?? 'no reason given'}`, payload.type, false);
        this._finalise_task(task, payload.reason, true);
        this._tasks.delete(taskId);
        break;
      }
      case 'TASK_COMPLETED': {
        const task = this._tasks.get(taskId);
        if (task) {
          this._closePhase(task, 'task', env.ts, 'succeeded', payload.type);
        }
        this._tasks.delete(taskId);
        break;
      }
    }
  }

  // ── Tool handling ──────────────────────────────────────────────────────────

  private _handleToolEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as {
      type: string;
      turnId?: string;
      callId?: string;
      tool?: string;
      error?: string;
      approved?: boolean;
      phase?: string;
      limitMs?: number;
      elapsedMs?: number;
      limitTokens?: number;
      usedTokens?: number;
      limitCostUsd?: number;
      usedCostUsd?: number;
    };

    if (payload.callId && payload.turnId) {
      this._callToTurn.set(payload.callId, payload.turnId);
    }

    switch (payload.type) {
      case 'TOOL_FAILED': {
        if (!payload.turnId) break;
        const t = this._turns.get(payload.turnId);
        if (!t) break;
        t.hasToolFailure = true;
        this._addCausal(
          t, env.ts,
          `Tool "${payload.tool ?? 'unknown'}" failed: ${payload.error ?? 'unknown error'}`,
          payload.type,
          false,
          payload.tool ? { tool: payload.tool } : undefined,
        );
        if (payload.callId) this._callToTurn.delete(payload.callId);
        break;
      }
      case 'BUDGET_EXCEEDED_MS':
      case 'BUDGET_EXCEEDED_TOKENS':
      case 'BUDGET_EXCEEDED_COST': {
        if (!payload.turnId || !payload.callId) break;
        const t = this._turns.get(payload.turnId);
        if (!t) break;
        t.budgetBreaches.push({
          callId: payload.callId,
          tool: payload.tool ?? 'unknown',
          eventType: payload.type,
          phase: payload.phase ?? 'unknown',
          ts: env.ts,
          meta: {
            ...(payload.limitMs !== undefined ? { limitMs: payload.limitMs } : {}),
            ...(payload.elapsedMs !== undefined ? { elapsedMs: payload.elapsedMs } : {}),
            ...(payload.limitTokens !== undefined ? { limitTokens: payload.limitTokens } : {}),
            ...(payload.usedTokens !== undefined ? { usedTokens: payload.usedTokens } : {}),
            ...(payload.limitCostUsd !== undefined ? { limitCostUsd: payload.limitCostUsd } : {}),
            ...(payload.usedCostUsd !== undefined ? { usedCostUsd: payload.usedCostUsd } : {}),
          },
        });
        this._addCausal(
          t,
          env.ts,
          `Tool "${payload.tool ?? 'unknown'}" exceeded runtime budget (${payload.type}) during ${payload.phase ?? 'unknown phase'}`,
          payload.type,
          false,
          { tool: payload.tool ?? 'unknown', phase: payload.phase ?? 'unknown' },
        );
        break;
      }
      case 'TOOL_PERMISSION_CHECKED': {
        // If approved is explicitly false, record permission denial
        if (payload.approved === false && payload.turnId) {
          const t = this._turns.get(payload.turnId);
          if (!t) break;
          t.hasPermissionDenial = true;
          this._addCausal(
            t, env.ts,
            `Permission denied for tool "${payload.tool ?? 'unknown'}"`,
            payload.type,
            false,
            payload.tool ? { tool: payload.tool } : undefined,
          );
        }
        break;
      }
      case 'TOOL_SUCCEEDED':
      case 'TOOL_CANCELLED': {
        if (payload.callId) this._callToTurn.delete(payload.callId);
        break;
      }
    }
  }

  private _handlePermissionEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as {
      type: string;
      callId?: string;
      tool?: string;
      approved?: boolean;
      source?: string;
    };
    const callId = payload.callId;
    if (!callId) return;
    const turnId = this._callToTurn.get(callId);
    if (!turnId) return;
    const tracker = this._turns.get(turnId);
    if (!tracker) return;

    if (payload.type === 'PERMISSION_REQUESTED') {
      tracker.permissionEvidence.push({
        callId,
        tool: payload.tool ?? 'unknown',
        requestedAt: env.ts,
      });
      return;
    }

    if (payload.type === 'DECISION_EMITTED') {
      const existing = tracker.permissionEvidence.find((entry) => entry.callId === callId);
      if (existing) {
        const idx = tracker.permissionEvidence.indexOf(existing);
        tracker.permissionEvidence[idx] = {
          ...existing,
          tool: payload.tool ?? existing.tool,
          decidedAt: env.ts,
          durationMs: existing.requestedAt !== undefined ? env.ts - existing.requestedAt : undefined,
          approved: payload.approved,
          source: payload.source,
        };
      } else {
        tracker.permissionEvidence.push({
          callId,
          tool: payload.tool ?? 'unknown',
          decidedAt: env.ts,
          approved: payload.approved,
          source: payload.source,
        });
      }
    }
  }

  // ── Compaction handling ────────────────────────────────────────────────────

  private _handleCompactionEnvelope(
    env: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>
  ): void {
    const payload = env.payload as { type: string; turnId?: string; error?: string };
    if (payload.type !== 'COMPACTION_FAILED') return;

    // Mark all active turns as having a compaction error
    for (const t of this._turns.values()) {
      if (t.sessionId === env.sessionId) {
        t.hasCompactionError = true;
        this._addCausal(t, env.ts, `Compaction failed: ${payload.error ?? 'unknown error'}`, payload.type, false);
      }
    }
  }

  // ── Report finalisation ───────────────────────────────────────────────────

  private _finalise_turn(
    tracker: TurnTracker,
    stopReason: string | undefined,
    errorMessage: string | undefined,
    wasCancelled: boolean,
  ): void {
    const classification = classifyFailure({
      stopReason,
      errorMessage,
      wasCancelled,
      hasCascadeEvents: tracker.hasCascadeEvents,
      hasToolFailure: tracker.hasToolFailure,
      hasPermissionDenial: tracker.hasPermissionDenial,
      hasCompactionError: tracker.hasCompactionError,
    });

    const summary = summariseFailure(classification, errorMessage, stopReason);

    const jumpLinks: ForensicsJumpLink[] = [
      { label: 'Open tool inspector', kind: 'panel', target: 'tools' },
      { label: 'Open health dashboard', kind: 'panel', target: 'provider-health' },
    ];

    const reportId = this._shortId(tracker.traceId);

    const report: FailureReport = {
      id: reportId,
      traceId: tracker.traceId,
      sessionId: tracker.sessionId,
      generatedAt: Date.now(),
      classification,
      summary,
      stopReason,
      errorMessage,
      turnId: tracker.turnId,
      phaseTimings: tracker.phaseTimings,
      phaseLedger: tracker.phaseLedger,
      causalChain: tracker.causalChain,
      cascadeEvents: tracker.cascadeEvents,
      permissionEvidence: tracker.permissionEvidence,
      budgetBreaches: tracker.budgetBreaches,
      jumpLinks,
    };

    this._registry.push(report);
    emitForensicsReportCreated(this._bus, { sessionId: tracker.sessionId, traceId: tracker.traceId, source: 'ForensicsCollector' }, {
      reportId: report.id,
      classification: report.classification,
      errorMessage: report.errorMessage,
      turnId: report.turnId,
    });
  }

  private _finalise_task(
    tracker: TaskTracker,
    errorMessage: string | undefined,
    wasCancelled: boolean,
  ): void {
    const classification = classifyFailure({
      errorMessage,
      wasCancelled,
      hasCascadeEvents: tracker.hasCascadeEvents,
      hasToolFailure: tracker.hasToolFailure,
      hasPermissionDenial: tracker.hasPermissionDenial,
      hasCompactionError: tracker.hasCompactionError,
    });

    const summary = summariseFailure(classification, errorMessage);

    const jumpLinks: ForensicsJumpLink[] = [
      { label: 'View in ops-control', kind: 'panel', target: 'ops-control' },
      { label: 'Open health dashboard', kind: 'panel', target: 'provider-health' },
    ];

    const reportId = this._shortId(tracker.traceId);

    const report: FailureReport = {
      id: reportId,
      traceId: tracker.traceId,
      sessionId: tracker.sessionId,
      generatedAt: Date.now(),
      classification,
      summary,
      errorMessage,
      taskId: tracker.taskId,
      agentId: tracker.agentId,
      phaseTimings: tracker.phaseTimings,
      phaseLedger: tracker.phaseLedger,
      causalChain: tracker.causalChain,
      cascadeEvents: tracker.cascadeEvents,
      permissionEvidence: tracker.permissionEvidence,
      budgetBreaches: tracker.budgetBreaches,
      jumpLinks,
    };

    this._registry.push(report);
    emitForensicsReportCreated(this._bus, { sessionId: tracker.sessionId, traceId: tracker.traceId, source: 'ForensicsCollector' }, {
      reportId: report.id,
      classification: report.classification,
      errorMessage: report.errorMessage,
      taskId: report.taskId,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _transitionPhase(
    t: TurnTracker | TaskTracker,
    domain: 'turn' | 'task',
    nextPhase: string,
    ts: number,
    eventType: string,
  ): void {
    this._closePhase(t, domain, ts, 'succeeded', eventType);
    (t as { currentPhase?: string }).currentPhase = nextPhase;
    (t as { lastPhaseStart?: number }).lastPhaseStart = ts;
    (t as { currentPhaseEnterEventType?: string }).currentPhaseEnterEventType = eventType;
  }

  private _closePhase(
    t: TurnTracker | TaskTracker,
    domain: 'turn' | 'task',
    ts: number,
    outcome: Extract<PhaseLedgerOutcome, 'succeeded' | 'failed' | 'cancelled'>,
    eventType: string,
    error?: string,
  ): void {
    if (!t.currentPhase || t.lastPhaseStart === undefined) return;
    t.phaseTimings.push({
      phase: t.currentPhase,
      startedAt: t.lastPhaseStart,
      endedAt: ts,
      durationMs: ts - t.lastPhaseStart,
      success: outcome === 'succeeded',
      error,
    });
    t.phaseLedger.push({
      seq: ++t._phaseSeq,
      domain,
      phase: t.currentPhase,
      enterEventType: t.currentPhaseEnterEventType ?? 'unknown',
      enteredAt: t.lastPhaseStart,
      exitEventType: eventType,
      exitedAt: ts,
      durationMs: ts - t.lastPhaseStart,
      outcome,
      error,
    });
  }

  private _addCausal(
    t: TurnTracker | TaskTracker,
    ts: number,
    description: string,
    sourceEventType: string,
    isRootCause: boolean,
    context?: Record<string, string | number | boolean>,
  ): void {
    t.causalChain.push({
      seq: ++t._causalSeq,
      ts,
      description,
      sourceEventType,
      isRootCause,
      context,
    });
  }

  /** Derive a short human-readable report ID from a trace ID. */
  private _shortId(traceId: string): string {
    // Use the first 8 hex chars of the trace ID, fall back to a fresh UUID prefix
    const clean = traceId.replace(/-/g, '');
    return clean.length >= 8 ? clean.slice(0, 8) : randomUUID().replace(/-/g, '').slice(0, 8);
  }

  /** Dispose all event bus subscriptions. */
  public dispose(): void {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch { /* non-fatal */ }
    }
    this._unsubs.length = 0;
    this._turns.clear();
    this._tasks.clear();
    this._callToTurn.clear();
  }
}
