import type { Tool, ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ToolRuntimeContext } from './context.ts';
import type { ExecutorConfig, PhaseResult, ToolExecutionPhase, ToolExecutionRecord } from '@pellux/goodvibes-sdk/platform/runtime/tools/types';
import {
  emitBudgetExceededCost,
  emitBudgetExceededMs,
  emitBudgetExceededTokens,
  emitToolCancelled,
  emitToolExecuting,
  emitToolFailed,
  emitToolMapped,
  emitToolPermissioned,
  emitToolPosthooked,
  emitToolPrehooked,
  emitToolSucceeded,
  emitToolValidated,
} from '../emitters/tools.ts';
import {
  budgetPhase,
  executePhase,
  mapOutputPhase,
  permissionPhase,
  posthookPhase,
  prehookPhase,
  validatePhase,
} from './phases/index.ts';

/**
 * PhasedToolExecutor — runs a ToolCall through the multi-phase execution pipeline.
 *
 * Pipeline (in order):
 *   validate → prehook → permission → execute → mapOutput → posthook → succeeded
 *
 * Any phase that sets `abort: true` on its PhaseResult will halt the pipeline
 * and transition to the `failed` or `cancelled` terminal state.
 *
 * Cancellation is cooperative: the executor checks `context.cancellation.signal`
 * at each phase boundary and immediately transitions to `cancelled` when aborted.
 *
 * @example
 * ```ts
 * const executor = createPhasedExecutor({ enableHooks: true, enablePermissions: true, enableEvents: true });
 * const result = await executor.execute(call, tool, context);
 * ```
 */
/** Maximum number of completed records retained in memory before eviction. */
const MAX_RECORDS = 1000;

export class PhasedToolExecutor {
  private readonly config: ExecutorConfig;
  private readonly records = new Map<string, ToolExecutionRecord>();
  private readonly controllers = new Map<string, AbortController>();
  /** Maps ToolCall instances to their idempotency key without mutating the input. */
  private readonly _idKeyMap = new WeakMap<ToolCall, string>();

  constructor(config: ExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute a tool call through all pipeline phases.
   * Returns a ToolResult regardless of outcome — callers never need to catch.
   */
  async execute(
    call: ToolCall,
    tool: Tool,
    context: ToolRuntimeContext,
  ): Promise<ToolResult> {
    // --- Idempotency check ---
    // Must run before creating a record to avoid registering calls that will be
    // short-circuited as duplicates or rejected as in-flight.
    if (this.config.idempotencyStore) {
      const idKey = this.config.idempotencyStore.generateKey({
        sessionId: context.ids.sessionId,
        turnId: context.ids.turnId,
        callId: call.id,
      });
      const check = this.config.idempotencyStore.checkAndRecord(idKey);

      if (check.status === 'duplicate') {
        logger.debug('PhasedToolExecutor: duplicate tool call — returning cached result', {
          callId: call.id,
          tool: call.name,
          idKey,
          priorStatus: check.record.status,
        });
        // Return the cached result from the prior completed execution.
        // If the prior run failed (status === 'failed'), the cached result will
        // be undefined and we return a generic error to the LLM.
        if (check.record.result !== undefined) {
          return check.record.result as ToolResult;
        }
        return {
          callId: call.id,
          success: false,
          error: 'Duplicate tool call: prior execution failed; retry is not permitted.',
        };
      }

      if (check.status === 'in-flight') {
        logger.warn('PhasedToolExecutor: in-flight duplicate detected — rejecting', {
          callId: call.id,
          tool: call.name,
          idKey,
          inFlightSince: check.record.createdAt,
        });
        return {
          callId: call.id,
          success: false,
          error: 'Duplicate tool call: an identical submission is already in-flight.',
        };
      }

      // 'new' — proceed; store the key so _fail/_cancel can markFailed.
      this._idKeyMap.set(call, idKey);
    }

    const record: ToolExecutionRecord = {
      callId: call.id,
      toolName: call.name,
      phases: [],
      currentPhase: 'received',
      startedAt: performance.now(),
      wallStartedAt: Date.now(),
      cancelled: false,
    };
    this.records.set(call.id, record);
    this._evictOldestCompleted();

    // Create a per-execution AbortController. cancel() aborts this controller;
    // the pipeline loop checks controller.signal.aborted at every boundary.
    // The outer context.cancellation.signal is also respected via a forwarding listener.
    const controller = new AbortController();
    this.controllers.set(call.id, controller);
    const cancelSignal = controller.signal;
    // Forward outer cancellation into our local controller
    const forwardAbort = () => controller.abort(context.cancellation.reason);
    if (context.cancellation.signal.aborted) {
      controller.abort(context.cancellation.reason);
    } else {
      context.cancellation.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    // --- Phase pipeline ---
    // Each entry: [phase name used for cancellation check, phase function, config guard]
    type PipelineEntry = [
      phase: ToolExecutionPhase,
      fn: (call: ToolCall, tool: Tool, context: ToolRuntimeContext, record: ToolExecutionRecord) => Promise<PhaseResult & { toolResult?: ToolResult }>,
      enabled: boolean,
    ];

    const budgetEnabled = this.config.enableBudgetEnforcement === true;

    const pipeline: PipelineEntry[] = [
      ['validated',     validatePhase,                                              true],
      ['prehooked',     prehookPhase,                                               this.config.enableHooks],
      ['permissioned',  permissionPhase,                                            this.config.enablePermissions],
      ['budget-entry',  (c, t, ctx, r) => budgetPhase(c, t, ctx, r, 'entry'),      budgetEnabled],
      ['executing',     (c, t, ctx, r) => executePhase(c, t, ctx, r, this.config), true],
      ['mapped',        mapOutputPhase,                                             true],
      ['budget-exit',   (c, t, ctx, r) => budgetPhase(c, t, ctx, r, 'exit'),       budgetEnabled],
      ['posthooked',    posthookPhase,                                              this.config.enableHooks],
    ];

    const emitterCtx = {
      sessionId: context.ids.sessionId,
      traceId:   context.ids.traceId,
      source:    'phased-executor' as const,
    };

    for (const [phaseName, phaseFn, enabled] of pipeline) {
      // --- Cancellation check at every boundary ---
      if (cancelSignal.aborted) {
        context.cancellation.signal.removeEventListener('abort', forwardAbort);
        this.controllers.delete(call.id);
        return this._cancel(record, call, context, emitterCtx, cancelSignal.reason as string | undefined);
      }

      if (!enabled) {
        continue;
      }

      record.currentPhase = phaseName;
      const phaseResult = await phaseFn(call, tool, context, record);
      record.phases.push(phaseResult);

      // --- Emit per-phase event ---
      if (this.config.enableEvents && context.runtimeBus) {
        this._emitPhaseEvent(phaseName, phaseResult, call, context, emitterCtx);
      }

      // --- Capture execute result ---
      if (phaseName === 'executing' && phaseResult.toolResult) {
        record.result = phaseResult.toolResult;
      }

      // --- Handle phase failure/abort ---
      if (!phaseResult.success || phaseResult.abort) {
        context.cancellation.signal.removeEventListener('abort', forwardAbort);
        this.controllers.delete(call.id);

        // Emit typed budget breach event before failing
        if (phaseResult.budgetExceedReason && this.config.enableEvents && context.runtimeBus) {
          this._emitBudgetEvent(
            phaseResult.budgetExceedReason,
            phaseResult.budgetMeta ?? {},
            phaseName,
            call,
            context,
            emitterCtx,
          );
        }

        return this._fail(record, call, context, emitterCtx, phaseResult.error ?? 'Phase failed');
      }
    }

    // --- Final cancellation check before transitioning to succeeded ---
    context.cancellation.signal.removeEventListener('abort', forwardAbort);
    if (cancelSignal.aborted) {
      this.controllers.delete(call.id);
      return this._cancel(record, call, context, emitterCtx, cancelSignal.reason as string | undefined);
    }

    // --- Succeeded ---
    this.controllers.delete(call.id);
    record.currentPhase = 'succeeded';
    const durationMs = performance.now() - record.startedAt;
    record.completedAt = Date.now();
    if (this.config.enableEvents && context.runtimeBus) {
      emitToolSucceeded(context.runtimeBus, emitterCtx, {
        callId: call.id,
        turnId: context.ids.turnId,
        tool: call.name,
        durationMs,
      });
    }

    context.tasks.onComplete?.(call.id, durationMs);

    const finalResult: ToolResult = record.result ?? {
      callId: call.id,
      success: true,
    };

    // --- Idempotency: cache the successful result ---
    const idKey = this._getIdKey(call);
    if (idKey && this.config.idempotencyStore) {
      this.config.idempotencyStore.markComplete(idKey, finalResult);
    }

    return finalResult;
  }

  /**
   * Cancel an in-flight tool execution.
   * Sets a cancelled flag on the record; the next phase boundary will pick it up.
   */
  cancel(callId: string, reason?: string): void {
    const record = this.records.get(callId);
    if (record && !record.completedAt) {
      record.cancelled = true;
      record.cancelledReason = reason;
      this.controllers.get(callId)?.abort(reason);
    }
  }

  /** Returns the full execution record for a given call id, if any. */
  getRecord(callId: string): ToolExecutionRecord | undefined {
    return this.records.get(callId);
  }

  /** Returns all execution records for in-flight calls. */
  getActiveRecords(): ToolExecutionRecord[] {
    return Array.from(this.records.values()).filter((r) => !r.completedAt);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract the idempotency key previously attached to a call during `execute`.
   * Returns `undefined` if no idempotency store is configured.
   */
  private _getIdKey(call: ToolCall): string | undefined {
    return this._idKeyMap.get(call);
  }

  private _fail(
    record: ToolExecutionRecord,
    call: ToolCall,
    context: ToolRuntimeContext,
    emitterCtx: { sessionId: string; traceId: string; source: string },
    error: string,
  ): ToolResult {
    record.currentPhase = 'failed';
    const durationMs = performance.now() - record.startedAt;
    record.completedAt = Date.now();

    if (this.config.enableEvents && context.runtimeBus) {
      emitToolFailed(context.runtimeBus, emitterCtx as Parameters<typeof emitToolFailed>[1], {
        callId: call.id,
        turnId: context.ids.turnId,
        tool: call.name,
        error,
        durationMs,
      });
    }

    context.tasks.onError?.(call.id, error);

    // --- Idempotency: mark failed to allow retry ---
    const idKey = this._getIdKey(call);
    if (idKey && this.config.idempotencyStore) {
      this.config.idempotencyStore.markFailed(idKey);
    }

    return {
      callId: call.id,
      success: false,
      error,
    };
  }

  private _cancel(
    record: ToolExecutionRecord,
    call: ToolCall,
    context: ToolRuntimeContext,
    emitterCtx: { sessionId: string; traceId: string; source: string },
    reason?: string,
  ): ToolResult {
    record.currentPhase = 'cancelled';
    record.cancelled = true;
    record.cancelledReason = reason;
    record.completedAt = Date.now();

    if (this.config.enableEvents && context.runtimeBus) {
      emitToolCancelled(
        context.runtimeBus,
        emitterCtx as Parameters<typeof emitToolCancelled>[1],
        {
          callId: call.id,
          turnId: context.ids.turnId,
          tool: call.name,
          reason,
        },
      );
    }

    // --- Idempotency: mark failed so the cancelled call can be retried ---
    const idKey = this._getIdKey(call);
    if (idKey && this.config.idempotencyStore) {
      this.config.idempotencyStore.markFailed(idKey);
    }

    return {
      callId: call.id,
      success: false,
      error: reason ? `Cancelled: ${reason}` : 'Tool call cancelled',
    };
  }

  /**
   * Evicts the oldest completed records when the map exceeds MAX_RECORDS.
   * Only completed records are eligible for eviction.
   */
  private _evictOldestCompleted(): void {
    if (this.records.size <= MAX_RECORDS) return;
    for (const [id, record] of this.records) {
      if (record.completedAt) {
        this.records.delete(id);
        if (this.records.size <= MAX_RECORDS) break;
      }
    }
  }

  private _emitBudgetEvent(
    reason: import('@pellux/goodvibes-sdk/platform/runtime/tools/types').BudgetExceedReason,
    meta: Record<string, number>,
    phase: ToolExecutionPhase,
    call: ToolCall,
    context: ToolRuntimeContext,
    emitterCtx: Parameters<typeof emitToolValidated>[1],
  ): void {
    if (!context.runtimeBus) return;
    const base = { callId: call.id, turnId: context.ids.turnId, tool: call.name, phase: String(phase) };
    switch (reason) {
      case 'BUDGET_EXCEEDED_MS':
        emitBudgetExceededMs(context.runtimeBus, emitterCtx, {
          ...base,
          limitMs: meta['limitMs'] ?? 0,
          elapsedMs: meta['elapsedMs'] ?? 0,
        });
        break;
      case 'BUDGET_EXCEEDED_TOKENS':
        emitBudgetExceededTokens(context.runtimeBus, emitterCtx, {
          ...base,
          limitTokens: meta['limitTokens'] ?? 0,
          usedTokens: meta['usedTokens'] ?? 0,
        });
        break;
      case 'BUDGET_EXCEEDED_COST':
        emitBudgetExceededCost(context.runtimeBus, emitterCtx, {
          ...base,
          limitCostUsd: meta['limitCostUsd'] ?? 0,
          usedCostUsd: meta['usedCostUsd'] ?? 0,
        });
        break;
      default:
        break;
    }
  }

  private _emitPhaseEvent(
    phase: ToolExecutionPhase,
    _result: PhaseResult,
    call: ToolCall,
    context: ToolRuntimeContext,
    emitterCtx: Parameters<typeof emitToolValidated>[1],
  ): void {
    if (!context.runtimeBus) return;
    const base = { callId: call.id, turnId: context.ids.turnId, tool: call.name };
    switch (phase) {
      case 'validated':
        emitToolValidated(context.runtimeBus, emitterCtx, base);
        break;
      case 'prehooked':
        emitToolPrehooked(context.runtimeBus, emitterCtx, base);
        break;
      case 'permissioned':
        emitToolPermissioned(context.runtimeBus, emitterCtx, { ...base, approved: _result.success });
        break;
      case 'executing':
        emitToolExecuting(context.runtimeBus, emitterCtx, { ...base, startedAt: Date.now() });
        break;
      case 'mapped':
        emitToolMapped(context.runtimeBus, emitterCtx, base);
        break;
      case 'posthooked':
        emitToolPosthooked(context.runtimeBus, emitterCtx, base);
        break;
      default:
        break;
    }
  }
}
