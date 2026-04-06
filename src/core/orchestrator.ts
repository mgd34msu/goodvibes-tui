import type { ConversationManager } from './conversation.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import { PermissionError, ProviderError, ToolError, isNonTransientProviderFailure } from '../types/errors.ts';
import type { HookEvent, HookResult } from '../hooks/types.ts';
import { formatProviderError } from '../utils/error-display.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { ModelDefinition } from '../providers/registry.ts';
import type { LLMProvider, StreamDelta, ContentPart } from '../providers/interface.ts';
import { configManager, DEFAULT_CONFIG } from '../config/index.ts';
import { notifyCompletion } from '../utils/notify.ts';
import { logger } from '../utils/logger.ts';
import type { PermissionManager } from '../permissions/manager.ts';
import type { AcpManager } from '../acp/manager.ts';
import type { SubagentTask } from '../acp/protocol.ts';
import { planManager } from './plan-manager-instance.ts';
import { ConsecutiveErrorBreaker } from './circuit-breaker.ts';
import type { ExecutionPlan, PlanItem } from './execution-plan.ts';
import { classifyIntent } from './intent-classifier.ts';
import { getTokenLimitsForModel, getContextWindowForModel } from '../providers/model-limits.ts';
import { estimateConversationTokens } from './context-compaction.ts';
import { sessionMemoryStore } from './session-memory.ts';
import { sessionLineageTracker } from './session-lineage.ts';
import { getCatalog } from '../providers/model-catalog.ts';
import { recordUsage } from '../providers/favorites.ts';
import { EventReplayQueue } from './event-replay.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { THINKING_SPINNER_FRAMES } from '../renderer/progress.ts';
import { randomUUID, createHash } from 'node:crypto';
import { cacheHitTracker } from '../providers/cache-strategy.ts';
import { helperModel } from '../config/helper-model.ts';
import { idempotencyStore } from '../runtime/idempotency/index.ts';
import { type ReconciliationReason } from './tool-reconciliation.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.ts';
import { adaptivePlanner } from './adaptive-planner-instance.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import {
  emitOpsCacheMetrics,
  emitOpsHelperUsage,
  emitToolExecuting,
  emitToolFailed,
  emitToolPermissioned,
  emitToolReconciled,
  emitToolReceived,
  emitToolSucceeded,
  emitLlmResponseReceived,
  emitPlanStrategySelected,
  emitPreflightFail,
  emitPreflightOk,
  emitStreamDelta,
  emitStreamEnd,
  emitStreamStart,
  emitTurnCancel,
  emitTurnCompleted,
  emitTurnError,
  emitTurnSubmitted,
} from '../runtime/emitters/index.ts';
import {
  autoSpawnPendingItems,
  executeToolCalls,
  reconcileUnresolvedToolCalls,
} from './orchestrator-tool-runtime.ts';
import {
  checkContextWindowPreflight,
  emitContextOverflowError,
  handlePostTurnContextMaintenance,
} from './orchestrator-context-runtime.ts';
import {
  emitMalformedToolUseWarning,
  handleFinalResponseOutcome,
  handleToolResponseOutcome,
  type ChatResponseWithReasoning,
  maybeEmitAdaptivePlannerDecision,
  prepareConversationForTurn,
} from './orchestrator-turn-helpers.ts';

/** Minimal interface for hook dispatch — allows any compatible implementation */
interface HookDispatcherLike {
  fire(event: HookEvent): Promise<HookResult>;
}

/** Delay (ms) before auto-spawning plan items if the model ends its turn without spawning them. */
const AUTO_SPAWN_FALLBACK_DELAY_MS = 5_000;

/**
 * Orchestrator - Manages LLM turn lifecycle with full tool-use loop.
 * Supports multi-turn agent loops: call LLM -> execute tools -> send results -> repeat.
 */
export class Orchestrator {
  public isThinking = false;
  public thinkingFrame = 0;
  public usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /**
   * Input tokens from the most recent LLM response — represents current context window usage.
   * Includes cache read/write tokens for accurate context window occupancy.
   * Value is 0 before the first LLM response (context bar shows empty, which is correct).
   */
  public lastInputTokens = 0;
  /** Approximate input tokens for the current streaming turn (from prior turn's response). */
  public streamingInputTokens = 0;
  /** Output tokens received so far in the current streaming turn (one per delta chunk). */
  public streamingOutputTokens = 0;
  public messageQueue: { text: string; content?: ContentPart[] }[] = [];

  private animInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private autoSpawnTimeout: ReturnType<typeof setTimeout> | null = null;
  private acpManager: AcpManager | null = null;
  /** Message count at the start of a turn, used to rollback on cancel. */
  private turnStartMessageCount = 0;
  /** Whether a streaming block is currently active (for cleanup on abort). */
  private isStreaming = false;
  /** Last token warning bracket (multiples of 10%) to avoid repeat warnings at same level. */
  private lastWarningBracket = 0;
  /** Whether auto-compaction is currently in progress (prevents re-entry). */
  private isCompacting = false;

  /** Session ID for hook events — unique per Orchestrator instance */
  private readonly sessionId = randomUUID();

  /**
   * Submission key for the currently active turn.
   *
   * Generated at the start of each `runTurn` call and used as the idempotency
   * key for the turn-level deduplication fence. A duplicate `runTurn` call with
   * the same text that arrives while a turn is still in-flight will be detected
   * via the shared `idempotencyStore` and rejected before re-executing.
   *
   * The key is reset to `null` when the turn completes.
   */
  public currentSubmissionKey: string | null = null;

  /**
   * Tracks whether the current turn ended in failure.
   * Set to `true` in the catch block; read in `finally` to decide markComplete vs markFailed.
   */
  private _turnFailed = false;

  /** Event replay queue — ensures model acknowledges significant events */
  private readonly replayQueue: EventReplayQueue;

  /** Cleanup function returned by the active replay queue attachment. */
  private detachReplay: (() => void) | null = null;
  private readonly runtimeBus: RuntimeEventBus | null;

  /**
   * Optional feature flag manager.
   *
   * When provided, the `tool-result-reconciliation` flag is
   * consulted at each turn end to decide whether to use full reconciliation
   * (`enabled`) or skip reconciliation (`disabled`).
   * When `null`, reconciliation defaults to enabled (matching the flag's
   * declared `defaultState`).
   */
  private flagManager: FeatureFlagManager | null = null;

  /**
   * Tracks the last provider response's tool calls within the current turn
   * iteration so the reconciliation pass can detect unresolved calls when
   * the loop exits early.
   */
  private _pendingToolCalls: ToolCall[] = [];
  private readonly requestRender: () => void;

  constructor(
    private conversation: ConversationManager,
    private getViewportHeight: () => number,
    private scrollToEnd: (vHeight: number) => void,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private getSystemPrompt: () => string = () => '',
    private hookDispatcher: HookDispatcherLike | null = null,
    flagManager: FeatureFlagManager | null = null,
    requestRender: (() => void) | null = null,
    runtimeBus: RuntimeEventBus | null = null,
  ) {
    this.replayQueue = new EventReplayQueue();
    this.detachReplay = runtimeBus
      ? EventReplayQueue.attachToRuntimeBus(runtimeBus, this.replayQueue)
      : null;
    this.flagManager = flagManager;
    this.requestRender = requestRender ?? (() => {});
    this.runtimeBus = runtimeBus;
  }

  private emitterContext(turnId: string): import('../runtime/emitters/index.ts').EmitterContext {
    return {
      sessionId: this.sessionId,
      traceId: `${this.sessionId}:${turnId}`,
      source: 'orchestrator',
    };
  }

  /**
   * Attach an AcpManager and register the 'delegate' tool into the ToolRegistry.
   * Call this after construction, before the first turn.
   */
  public registerDelegateTool(manager: AcpManager): void {
    this.acpManager = manager;

    this.toolRegistry.register({
      definition: {
        name: 'delegate',
        description:
          'Delegate a task to a subagent child process via ACP. ' +
          'The subagent runs autonomously and reports results when complete. ' +
          'Returns the subagent ID immediately; results are delivered via subagent events.',
        parameters: {
          type: 'object',
          required: ['description', 'context', 'tools'],
          properties: {
            description: {
              type: 'string',
              description: 'Clear description of the task for the subagent to complete.',
            },
            context: {
              type: 'string',
              description: 'Additional context, constraints, or background information.',
            },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent is allowed to use.',
            },
            model: {
              type: 'string',
              description: 'Optional model override (e.g. "claude-sonnet-4-5").',
            },
            provider: {
              type: 'string',
              description: 'Optional provider override (e.g. "anthropic").',
            },
          },
        },
      },
      execute: async (args): Promise<{ success: boolean; output: string }> => {
        if (!this.acpManager) {
          return { success: false, output: 'ACP manager not initialized' };
        }

        const task: SubagentTask = {
          description: String(args.description ?? ''),
          context: String(args.context ?? ''),
          tools: Array.isArray(args.tools) ? args.tools.map(String) : [],
          model: args.model ? String(args.model) : undefined,
          provider: args.provider ? String(args.provider) : undefined,
        };

        const id = await this.acpManager.spawn(task);
        return {
          success: true,
          output: `Subagent spawned with ID: ${id}. Task: "${task.description}". The subagent is running in the background.`,
        };
      },
    });
  }

  public getSpinner(): string {
    return THINKING_SPINNER_FRAMES[this.thinkingFrame % THINKING_SPINNER_FRAMES.length];
  }

  /** Abort the current in-flight LLM request, if any. */
  public abort(): void {
    this.abortController?.abort();
    if (this.autoSpawnTimeout !== null) {
      clearTimeout(this.autoSpawnTimeout);
      this.autoSpawnTimeout = null;
    }
  }

  /**
   * handleUserInput - Entry point for a user-submitted message.
   * Queues if already thinking, otherwise kicks off the LLM turn.
   * @param text - Plain text representation (for display and queuing).
   * @param content - Optional ContentPart[] for multimodal messages.
   */
  public async handleUserInput(text: string, content?: ContentPart[]): Promise<void> {
    if (!text.trim() && !content?.length) return;

    if (this.isThinking || this.isCompacting) {
      this.messageQueue.push({ text, content });
      this.requestRender();
      return;
    }

    // Set the original task on the first user message (idempotent — subsequent calls are no-ops)
    sessionLineageTracker.setOriginalTask(text.slice(0, 200));

    await this.runTurn(text, content);

    // Process any messages queued while the LLM was thinking (iterative, not recursive)
    while (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift()!;
      await this.runTurn(next.text, next.content);
    }
  }

  private startThinking(): void {
    this.isThinking = true;
    this.thinkingFrame = 0; // Reset each turn so gradient starts clean and frame never grows unbounded
    this.streamingInputTokens = this.lastInputTokens;
    this.streamingOutputTokens = 0;
    this.abortController = new AbortController();
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = setInterval(() => {
      this.thinkingFrame++;
      this.requestRender();
    }, 80);
    this.requestRender();
  }

  private stopThinking(): void {
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = null;
    this.abortController = null;
    this.isThinking = false;
    this.streamingInputTokens = 0;
    this.streamingOutputTokens = 0;
    this.scrollToEnd(this.getViewportHeight());
    this.requestRender();
  }

  private async runTurn(text: string, content?: ContentPart[]): Promise<void> {
    const turnStartTime = Date.now();

    // --- Submission key — per-turn idempotency fence ---
    // Generates a stable, deterministic key for this turn using a SHA-256 hash
    // of the message content (first 512 chars) + conversation length as context.
    // If the same physical turn is replayed (reconnect/restart) before the
    // prior execution completes, the second attempt hits 'in-flight' and is
    // silently dropped. After completion the key expires via TTL.
    // Note: turnId is deliberately pre-hashed here (SHA-256, sliced to 16 chars) so
    // that long message text does not bloat the intermediate string passed to
    // generateKey — which applies its own SHA-256 internally. The double-hash is
    // intentional and harmless: the outer hash provides key isolation and the
    // inner hash ensures the final store key is a uniform 64-char hex digest.
    const turnId = createHash('sha256')
      .update(`${this.sessionId}:${this.conversation.getMessageCount()}:${text.slice(0, 512)}`)
      .digest('hex')
      .slice(0, 16); // 16-char prefix is sufficient for in-process dedup
    const submissionKey = idempotencyStore.generateKey({
      sessionId: this.sessionId,
      turnId,
      callId:    text.slice(0, 64), // use prompt prefix for human-readable correlation
    });
    const submissionCheck = idempotencyStore.checkAndRecord(submissionKey);
    this.currentSubmissionKey = submissionKey;

    if (submissionCheck.status === 'in-flight') {
      logger.warn('Orchestrator: duplicate turn submission detected (in-flight) — dropping', {
        sessionId: this.sessionId,
        submissionKey,
      });
      this.currentSubmissionKey = null;
      return;
    }
    // 'duplicate' (completed/failed) — allow re-run (user sent same text intentionally).
    // We just let it proceed; the prior record will be overwritten.

    if (this.runtimeBus) {
      emitTurnSubmitted(this.runtimeBus, this.emitterContext(turnId), { turnId, prompt: text });
    }

    // Adaptive Execution Planner.
    // If the feature flag is enabled, score and select the execution strategy
    // before the turn proceeds. The selected strategy and reason code are
    // emitted for the Ops panel and logged for observability.
    maybeEmitAdaptivePlannerDecision(
      text,
      this.flagManager?.isEnabled('adaptive-execution-planner') ?? false,
      this.runtimeBus,
      (id) => this.emitterContext(id),
      turnId,
    );
    // ────────────────────────────────────────────────────────────────────────

    // Pre-turn plan injection: if an active plan exists, inject its current state into
    // the conversation so the LLM can refer to it and update item statuses.
    const preTurnPlan = prepareConversationForTurn(this.conversation, text, content);

    this.turnStartMessageCount = this.conversation.getMessageCount();
    this.scrollToEnd(this.getViewportHeight());

    this.startThinking();

    try {
      const model = providerRegistry.getCurrentModel();
      const provider: LLMProvider = model.provider
        ? providerRegistry.get(model.provider)
        : providerRegistry.getForModel(model.id);
      const toolDefinitions = this.toolRegistry.getToolDefinitions();
      const streamEnabled = configManager.get('display.stream') as boolean;

      let continueLoop = true;
      const circuitBreaker = new ConsecutiveErrorBreaker();
      while (continueLoop) {
        // Wire up streaming delta handler when streaming is enabled
        let streamAccumulated = '';
        let reasoningAccumulated = '';
        const onDelta = streamEnabled
          ? (delta: StreamDelta) => {
              if (delta.content) {
                streamAccumulated += delta.content;
                this.conversation.updateStreamingBlock(streamAccumulated);
                this.streamingOutputTokens++;
              }
              if (delta.reasoning) {
                reasoningAccumulated += delta.reasoning;
              }
              if (this.runtimeBus) {
                emitStreamDelta(this.runtimeBus, this.emitterContext(turnId), {
                  turnId,
                  content: delta.content ?? '',
                  accumulated: streamAccumulated,
                  ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}),
                  ...(delta.toolCalls !== undefined ? { toolCalls: delta.toolCalls } : {}),
                });
              }
              this.requestRender();
            }
          : undefined;

        if (onDelta) {
          this.isStreaming = true;
          this.conversation.startStreamingBlock();
          if (this.runtimeBus) {
            emitStreamStart(this.runtimeBus, this.emitterContext(turnId), { turnId });
          }
        }

        // ── Context window pre-flight check ─────────────────────────────────
        // Before calling the provider, verify the request fits within the model's
        // context window. Auto-compact if enabled and threshold exceeded, otherwise
        // surface a clear error with token counts and suggest alternatives.
        // NOTE: Pre-flight compaction (compact-then-retry) and post-turn compaction
        // (compact after a successful turn, lines ~497+) share the same underlying
        // conversation.compact() mechanism but serve different triggers.
        const preflightResult = await this.checkContextWindowPreflight(turnId, model);
        if (preflightResult === 'error') {
          // Error message already added to conversation; clean up streaming block
          if (onDelta) {
            this.isStreaming = false;
            this.conversation.finalizeStreamingBlock();
            if (this.runtimeBus) {
              emitStreamEnd(this.runtimeBus, this.emitterContext(turnId), { turnId });
            }
          }
          if (this.runtimeBus) {
            emitPreflightFail(this.runtimeBus, this.emitterContext(turnId), {
              turnId,
              reason: 'context window preflight failed',
              stopReason: 'context_overflow',
            });
          }
          this._turnFailed = true;
          continueLoop = false;
          break;
        }
        // preflightResult === 'ok' or 'compacted' — proceed with chat call
        if (this.runtimeBus) {
          emitPreflightOk(this.runtimeBus, this.emitterContext(turnId), { turnId });
        }

        const tokenLimits = getTokenLimitsForModel(model);

        // Pre:llm:chat hook
        if (this.hookDispatcher) {
          const preEvent: HookEvent = {
            path: 'Pre:llm:chat',
            phase: 'Pre',
            category: 'llm',
            specific: 'chat',
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { model: model.id, provider: model.provider, messageCount: this.conversation.getMessagesForLLM().length },
          };
          const preResult = await this.hookDispatcher.fire(preEvent);
          if (preResult.decision === 'deny') {
            this.conversation.addSystemMessage(preResult.reason ?? 'LLM call blocked by hook');
            if (this.runtimeBus) {
              emitTurnError(this.runtimeBus, this.emitterContext(turnId), {
                turnId,
                error: preResult.reason ?? 'LLM call blocked by hook',
                stopReason: 'hook_denied',
              });
            }
            this._turnFailed = true;
            continueLoop = false;
            break;
          }
        }

        let response: Awaited<ReturnType<typeof provider.chat>>;
        try {
          response = await provider.chat({
            model: model.id,
            messages: this.conversation.getMessagesForLLM(),
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            systemPrompt: this.getSystemPrompt(),
            maxTokens: tokenLimits.maxOutputTokens,
            reasoningEffort: (() => {
              const configured = configManager.get('provider.reasoningEffort') as string | undefined;
              if (configured) return configured as 'instant' | 'low' | 'medium' | 'high';
              return model.capabilities.reasoning ? 'medium' : undefined;
            })(),
            signal: this.abortController?.signal,
            onDelta,
          });
        } catch (chatErr) {
          // Clean up streaming block on error
          if (onDelta) {
            this.isStreaming = false;
            this.conversation.finalizeStreamingBlock();
            if (this.runtimeBus) {
              emitStreamEnd(this.runtimeBus, this.emitterContext(turnId), { turnId });
            }
          }
          // Intercept 429 exhaustion for synthetic paid/subscription models and show actionable UX
          if (chatErr instanceof ProviderError && chatErr.statusCode === 429 && model.provider === 'synthetic' && model.tier !== 'free') {
            this.conversation.addSystemMessage(
              `All providers for ${model.displayName} are currently exhausted.\n` +
              `Options:\n` +
              `  • Wait a few minutes for the rate limit to reset and retry\n` +
              `  • Switch to a different model with /model\n` +
              `  • Switch to a free model via /model and selecting the free tier`
            );
            if (this.runtimeBus) {
              emitTurnError(this.runtimeBus, this.emitterContext(turnId), {
                turnId,
                error: 'All providers for the selected synthetic model are exhausted',
                stopReason: 'provider_exhausted',
              });
            }
            this._turnFailed = true;
            this.requestRender();
            continueLoop = false;
            break;
          }
          // Fail:llm:chat hook (fire-and-forget)
          if (this.hookDispatcher) {
            this.hookDispatcher.fire({
              path: 'Fail:llm:chat',
              phase: 'Fail',
              category: 'llm',
              specific: 'chat',
              sessionId: this.sessionId,
              timestamp: Date.now(),
              payload: { model: model.id, provider: model.provider, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
            }).catch((err: unknown) => { logger.debug('Fail:llm:chat hook error', { error: String(err) }); });
          }
          throw chatErr;
        }

        if (onDelta) {
          this.isStreaming = false;
          this.conversation.finalizeStreamingBlock();
          if (this.runtimeBus) {
            emitStreamEnd(this.runtimeBus, this.emitterContext(turnId), { turnId });
          }
        }

        void recordUsage(model.id);
        this.usage.input += response.usage.inputTokens;
        this.usage.output += response.usage.outputTokens;
        this.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
        this.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;

        // Emit cache metrics event
        const cacheMetrics = cacheHitTracker.getMetrics();
        if (cacheMetrics.turns > 0) {
          if (this.runtimeBus) {
            emitOpsCacheMetrics(this.runtimeBus, this.emitterContext(turnId), {
              hitRate: cacheMetrics.hitRate,
              cacheReadTokens: cacheMetrics.cacheReadTokens,
              cacheWriteTokens: cacheMetrics.cacheWriteTokens,
              totalInputTokens: cacheMetrics.totalInputTokens,
              turns: cacheMetrics.turns,
            });
          }
        }

        // Track helper model usage
        // Cumulative lifetime totals (not per-turn deltas) — consumers can diff successive events
        const helperUsage = helperModel.getUsage();
        if (helperUsage.calls > 0) {
          if (this.runtimeBus) {
            emitOpsHelperUsage(this.runtimeBus, this.emitterContext(turnId), {
              inputTokens: helperUsage.inputTokens,
              outputTokens: helperUsage.outputTokens,
              calls: helperUsage.calls,
            });
          }
        }

        // Warn on low cache hit rate (after enough data)
        // configManager.get() is generic (get<K>(key: K): ConfigValue<K>), so no cast needed
        const hitRateThreshold = configManager.get('cache.hitRateWarningThreshold');
        if (
          cacheMetrics.turns >= 5 &&
          cacheMetrics.hitRate < hitRateThreshold &&
          configManager.get('cache.monitorHitRate')
        ) {
          const pct = (cacheMetrics.hitRate * 100).toFixed(0);
          logger.info(`[Cache] Low hit rate: ${pct}% over ${cacheMetrics.turns} turns`);
        }

        this.lastInputTokens = response.usage.inputTokens
          + (response.usage.cacheReadTokens ?? 0)
          + (response.usage.cacheWriteTokens ?? 0);

        if (this.runtimeBus) {
          emitLlmResponseReceived(this.runtimeBus, this.emitterContext(turnId), {
            turnId,
            provider: model.provider,
            model: model.id,
            content: response.content,
            toolCallCount: response.toolCalls.length,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheReadTokens: response.usage.cacheReadTokens,
            cacheWriteTokens: response.usage.cacheWriteTokens,
          });
        }

        // Post:llm:chat hook (fire-and-forget)
        if (this.hookDispatcher) {
          this.hookDispatcher.fire({
            path: 'Post:llm:chat',
            phase: 'Post',
            category: 'llm',
            specific: 'chat',
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { model: model.id, provider: model.provider, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, toolCallCount: response.toolCalls.length },
          }).catch((err: unknown) => { logger.debug('Post:llm:chat hook error', { error: String(err) }); });
        }

        // Gather reasoning/thinking content from stream or response
        const reasoningForMsg = reasoningAccumulated || undefined;
        const reasoningSummaryForMsg = response.reasoningSummary || undefined;

        // ── Stop-reason completeness check ─────────────────────────────────────
        // Detect malformed provider responses: stopReason claims 'tool_use' but
        // no tool calls were returned. Reconcile immediately so the LLM receives
        // a synthetic error result on the next turn instead of an orphaned
        // tool_use block.
        if (response.stopReason === 'tool_use' && response.toolCalls.length === 0) {
          emitMalformedToolUseWarning({
            conversation: this.conversation,
            runtimeBus: this.runtimeBus,
            emitterContext: (id) => this.emitterContext(id),
            turnId,
            isReconciliationEnabled: this.isReconciliationEnabled(),
          });
        }

        if (response.toolCalls.length > 0) {
          const enrichedResponse: ChatResponseWithReasoning = {
            ...response,
            reasoning: reasoningForMsg,
            reasoningSummary: reasoningSummaryForMsg,
          };
          const results = await handleToolResponseOutcome({
            conversation: this.conversation,
            runtimeBus: this.runtimeBus,
            emitterContext: (id) => this.emitterContext(id),
            turnId,
            response: enrichedResponse,
            executeToolCalls: (id, calls) => this.executeToolCalls(id, calls),
            setPendingToolCalls: (calls) => { this._pendingToolCalls = calls; },
            messageQueueLength: this.messageQueue.length,
            requestRender: this.requestRender,
          });

          // --- Consecutive error circuit breaker ---
          // Count failures in this batch of tool results
          const allFailed = results.results.length > 0 && results.results.every(r => r.success === false);
          if (allFailed) {
            const cbResult = circuitBreaker.recordAllFailed();
            logger.warn(`Orchestrator: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
            if (cbResult === 'break') {
              // Log when circuit breaker trips so it's visible in logs
              logger.warn(`Orchestrator: circuit breaker tripped at ${circuitBreaker.consecutiveErrors} consecutive all-error turns`);
              this.conversation.addSystemMessage(
                `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. ` +
                `The loop is stopping to prevent an infinite failure cycle. ` +
                `Please reassess your approach and try a completely different strategy.`
              );
              if (this.runtimeBus) {
                emitTurnError(this.runtimeBus, this.emitterContext(turnId), {
                  turnId,
                  error: 'Consecutive all-failed tool turns tripped the circuit breaker',
                  stopReason: 'tool_loop_circuit_breaker',
                });
              }
              this._turnFailed = true;
              continueLoop = false;
            } else if (cbResult === 'warn') {
              this.conversation.addSystemMessage(
                `WARNING: You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
                `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
                `then try a completely different strategy.`
              );
            }
          } else if (results.results.length > 0) {
            // At least one success — reset the counter
            circuitBreaker.recordSuccess();
          }
          continueLoop = results.continueLoop;
        } else {
          const enrichedResponse: ChatResponseWithReasoning = {
            ...response,
            reasoning: reasoningForMsg,
            reasoningSummary: reasoningSummaryForMsg,
          };
          continueLoop = handleFinalResponseOutcome({
            conversation: this.conversation,
            runtimeBus: this.runtimeBus,
            emitterContext: (id) => this.emitterContext(id),
            turnId,
            response: enrichedResponse,
            preTurnPlan,
            requestRender: this.requestRender,
            setAutoSpawnTimeout: (timeout) => { this.autoSpawnTimeout = timeout; },
            autoSpawnTimeoutMs: AUTO_SPAWN_FALLBACK_DELAY_MS,
          });
        }
      }

      await handlePostTurnContextMaintenance({
        conversation: this.conversation,
        runtimeBus: this.runtimeBus,
        emitterContext: (id) => this.emitterContext(id),
        hookDispatcher: this.hookDispatcher,
        sessionId: this.sessionId,
        requestRender: this.requestRender,
        isCompacting: this.isCompacting,
        setIsCompacting: (value) => { this.isCompacting = value; },
        lastWarningBracket: this.lastWarningBracket,
        setLastWarningBracket: (value) => { this.lastWarningBracket = value; },
      }, turnId, this.lastInputTokens);
    } catch (err: unknown) {
      if (this.abortController?.signal.aborted) {
        // Clean up streaming block if one was active when aborted
        if (this.isStreaming) {
          this.isStreaming = false;
          this.conversation.finalizeStreamingBlock();
          if (this.runtimeBus) {
            emitStreamEnd(this.runtimeBus, this.emitterContext(turnId), { turnId });
          }
        }
        // Remove any partial LLM response, keep user message but mark it cancelled
        this.conversation.removeMessagesAfter(this.turnStartMessageCount);
        this.conversation.markLastUserMessageCancelled();
        this.conversation.addSystemMessage('[Response cancelled]');
        if (this.runtimeBus) {
          emitTurnCancel(this.runtimeBus, this.emitterContext(turnId), {
            turnId,
            reason: 'cancelled',
            stopReason: 'cancelled',
          });
        }
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error instanceof ProviderError ? formatProviderError(error) : `Error: ${error.message}`;
      this.conversation.addSystemMessage(msg);
      this.requestRender();
      // Graceful degradation — suggest alternative when provider fails non-transiently
      const autoSwitch = configManager.get('behavior.suggestAlternativeOnProviderFail') as boolean;
      if (autoSwitch && isNonTransientProviderFailure(err)) {
        const currentModel = providerRegistry.getCurrentModel();
        const alt = currentModel ? providerRegistry.findAlternativeModel(currentModel.id) : null;
        if (alt) {
          this.conversation.addSystemMessage(`[Provider] ${currentModel?.provider ?? 'Unknown'} failed. Alternative available: ${alt.displayName} (${alt.provider}). Use /model to switch.`);
        }
      }
      this._turnFailed = true;
      if (this.runtimeBus) {
        emitTurnError(this.runtimeBus, this.emitterContext(turnId), {
          turnId,
          error: error.message,
          stopReason: err instanceof ProviderError ? 'provider_error' : 'unexpected_error',
        });
      }
    } finally {
      // ── GC-ORCH-015: Terminal-state tool-call reconciliation ───────────────────
      // If the turn threw an exception between addAssistantMessage (which sets
      // _pendingToolCalls) and addToolResults (which clears it), there are
      // unresolved tool-call blocks in the conversation. Reconcile them now
      // so the conversation is always in a valid state on turn exit.
      if (this._pendingToolCalls.length > 0) {
        this.reconcileUnresolvedToolCalls([], 'exception-before-results');
      }

      // --- Submission key: mark turn complete or failed ---
      // Success: markComplete caches the result for duplicate callers.
      // Failure: markFailed allows retry on the next submission.
      if (this.currentSubmissionKey) {
        if (this._turnFailed) {
          idempotencyStore.markFailed(this.currentSubmissionKey);
        } else {
          idempotencyStore.markComplete(this.currentSubmissionKey);
        }
        this.currentSubmissionKey = null;
        this._turnFailed = false;
      }
      this.stopThinking();
      const durationMs = Date.now() - turnStartTime;
      const notifyEnabled = configManager.get('behavior.notifyOnComplete') as boolean | undefined;
      if (notifyEnabled !== false) {
        notifyCompletion('GoodVibes', `Response complete (${Math.round(durationMs / 1000)}s)`, durationMs);
      }

      // ── Event replay queue ────────────────────────────────────────────────
      // Signal turn completion; if any tracked events went unacknowledged,
      // inject them as system messages so the model sees them next turn.
      const eventsToReplay = this.replayQueue.onTurnComplete();
      if (eventsToReplay.length > 0) {
        const messages = this.replayQueue.formatReplays(eventsToReplay);
        for (const msg of messages) {
          this.conversation.addSystemMessage(msg);
        }
        this.requestRender();
      }
    }
  }

  /**
   * Pre-flight context window check.
   *
   * Estimates the token count of the pending request and compares it against
   * the model's context window from the catalog. If the request exceeds the
   * context window:
   *   1. If auto-compact is enabled (threshold configured), compact first.
   *   2. If still exceeds after compact, emit a clear error message with
   *      specific token counts and suggest alternatives.
   *
   * @returns 'ok' (within context), 'compacted' (compacted and now OK), or
   *          'error' (still exceeds even after compact, or compact disabled).
   */
  private async checkContextWindowPreflight(
    turnId: string,
    model: ModelDefinition,
  ): Promise<'ok' | 'compacted' | 'error'> {
    return checkContextWindowPreflight({
      conversation: this.conversation,
      requestRender: this.requestRender,
      hookDispatcher: this.hookDispatcher,
      sessionId: this.sessionId,
      runtimeBus: this.runtimeBus,
      emitterContext: (id) => this.emitterContext(id),
      isCompacting: this.isCompacting,
      setIsCompacting: (value) => { this.isCompacting = value; },
    }, turnId, model);
  }

  /**
   * Emit a user-facing error message when a request exceeds the model's context window,
   * including specific token counts and suggestions for alternative models.
   */
  private emitContextOverflowError(
    turnId: string,
    estimatedTokens: number,
    contextWindow: number,
    modelDisplayName: string,
    tier?: 'free' | 'paid' | 'subscription',
  ): void {
    emitContextOverflowError(this.conversation, this.requestRender, turnId, estimatedTokens, contextWindow, modelDisplayName, tier);
  }

  /**
   * Auto-spawn agents for a list of ready plan items under bounded orchestration policy.
   */
  private autoSpawnPendingItems(
    turnId: string,
    plan: ExecutionPlan,
    items: PlanItem[],
  ): string[] {
    return autoSpawnPendingItems(this.conversation, plan, items, this.runtimeBus, this.emitterContext(turnId));
  }

  /**
   * Returns `true` when the GC-ORCH-015 reconciliation feature is active.
   *
   * Defaults to `true` (flag `defaultState: 'enabled'`) when no flag manager
   * has been wired in — safe for tests that omit the optional constructor arg.
   */
  private isReconciliationEnabled(): boolean {
    if (this.flagManager === null) return true;
    return this.flagManager.isEnabled('tool-result-reconciliation');
  }

  /**
   * Reconcile unresolved tool calls at turn end.
   *
   * Called when the turn loop exits while `_pendingToolCalls` is non-empty,
   * or when a malformed provider response is detected. Injects synthetic error
   * results for every unresolved call, adds a system message, and emits a
   * typed `TOOL_RECONCILED` runtime event.
   *
   * When the feature flag is disabled this method logs a warning and returns
   * without taking action.
   *
   * @param resolvedResults - Tool results already collected this iteration.
   * @param reason          - Why reconciliation was triggered.
   */
  private reconcileUnresolvedToolCalls(
    resolvedResults: ToolResult[],
    reason: ReconciliationReason,
  ): void {
    reconcileUnresolvedToolCalls({
      conversation: this.conversation,
      runtimeBus: this.runtimeBus,
      emitterContext: (id) => this.emitterContext(id),
      isReconciliationEnabled: () => this.isReconciliationEnabled(),
      currentSubmissionKey: this.currentSubmissionKey,
      pendingToolCalls: this._pendingToolCalls,
      setPendingToolCalls: (calls) => { this._pendingToolCalls = calls; },
    }, resolvedResults, reason);
  }

  private async executeToolCalls(turnId: string, calls: ToolCall[]): Promise<ToolResult[]> {
    return executeToolCalls({
      toolRegistry: this.toolRegistry,
      permissionManager: this.permissionManager,
      hookDispatcher: this.hookDispatcher,
      runtimeBus: this.runtimeBus,
      sessionId: this.sessionId,
      emitterContext: (id) => this.emitterContext(id),
    }, turnId, calls);
  }
}
