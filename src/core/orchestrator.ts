import type { ConversationManager } from './conversation.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import { PermissionError, ProviderError, ToolError, isNonTransientProviderFailure } from '../types/errors.ts';
import type { HookEvent, HookResult } from '../hooks/types.ts';
import { formatError, summarizeError } from '../utils/error-display.ts';
import type { ModelDefinition } from '../providers/registry.ts';
import type { ContentPart } from '../providers/interface.ts';
import { notifyCompletion } from '../utils/notify.ts';
import { logger } from '../utils/logger.ts';
import type { PermissionManager } from '../permissions/manager.ts';
import type { AcpManager } from '../acp/manager.ts';
import type { SubagentTask } from '../acp/protocol.ts';
import { ConsecutiveErrorBreaker } from './circuit-breaker.ts';
import type { ExecutionPlan, PlanItem } from './execution-plan.ts';
import { classifyIntent } from './intent-classifier.ts';
import { estimateConversationTokens } from './context-compaction.ts';
import { SessionLineageTracker } from './session-lineage.ts';
import { EventReplayQueue } from './event-replay.ts';
import {
  type ConversationFollowUpItem,
} from './conversation-follow-ups.ts';
import { OrchestratorFollowUpRuntime } from './orchestrator-follow-up-runtime.ts';
import type { SystemMessageRouter } from './system-message-router.ts';
import { AgentManager } from '../tools/agent/index.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { THINKING_SPINNER_FRAMES } from '../renderer/progress.ts';
import { randomUUID, createHash } from 'node:crypto';
import { CacheHitTracker } from '../providers/cache-strategy.ts';
import { IdempotencyStore } from '../runtime/idempotency/index.ts';
import { type ReconciliationReason } from './tool-reconciliation.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { HelperModel } from '../config/helper-model.ts';
import {
  emitStreamEnd,
  emitTurnCancel,
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
  createEmitterContext,
  estimateFreshTurnInputTokens,
  getCacheHitTracker,
  getIdempotencyStore,
  getSessionLineageTracker,
  normalizeUsage,
  requireConfigManager,
  requireProviderRegistry,
  type OrchestratorCoreServices,
} from './orchestrator-runtime.ts';
import {
  type ChatResponseWithReasoning,
  maybeEmitAdaptivePlannerDecision,
  prepareConversationForTurn,
} from './orchestrator-turn-helpers.ts';
import { executeOrchestratorTurnLoop } from './orchestrator-turn-loop.ts';

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
  /** Fresh input tokens from the most recent turn (excluding cache-read reuse where applicable). */
  public lastRequestInputTokens = 0;
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
  private readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  private readonly wrfcController: Pick<WrfcController, 'listChains'>;
  private coreServices: OrchestratorCoreServices = {};
  private readonly ownedSessionLineageTracker = new SessionLineageTracker();
  private readonly ownedIdempotencyStore = new IdempotencyStore();
  private readonly ownedCacheHitTracker = new CacheHitTracker();

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
  private systemMessageRouter: Pick<SystemMessageRouter, 'low'> | null = null;
  private readonly followUpRuntime: OrchestratorFollowUpRuntime;

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
    services: {
      readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
      readonly wrfcController: Pick<WrfcController, 'listChains'>;
    },
  ) {
    this.replayQueue = new EventReplayQueue();
    this.detachReplay = runtimeBus
      ? EventReplayQueue.attachToRuntimeBus(runtimeBus, this.replayQueue)
      : null;
    this.flagManager = flagManager;
    this.requestRender = requestRender ?? (() => {});
    this.runtimeBus = runtimeBus;
    this.agentManager = services.agentManager;
    this.wrfcController = services.wrfcController;
    this.followUpRuntime = new OrchestratorFollowUpRuntime({
      conversation: this.conversation,
      getViewportHeight: () => this.getViewportHeight(),
      scrollToEnd: (height) => this.scrollToEnd(height),
      getSystemPrompt: () => this.getSystemPrompt(),
      requestRender: () => this.requestRender(),
      getThinkingState: () => ({ isThinking: this.isThinking, isCompacting: this.isCompacting }),
      getQueuedUserMessageCount: () => this.messageQueue.length,
      getProviderRegistry: () => requireProviderRegistry(this.coreServices),
      getCurrentModel: () => requireProviderRegistry(this.coreServices).getCurrentModel(),
      routeLowPriorityMessage: (message) => {
        if (this.systemMessageRouter) this.systemMessageRouter.low(message);
        else this.conversation.addSystemMessage(message);
      },
      applyUsage: (usage) => {
        this.usage.input += usage.inputTokens;
        this.usage.output += usage.outputTokens;
        this.usage.cacheRead += usage.cacheReadTokens ?? 0;
        this.usage.cacheWrite += usage.cacheWriteTokens ?? 0;
        this.lastRequestInputTokens = usage.inputTokens;
        this.lastInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      },
    });
  }

  public setCoreServices(services: OrchestratorCoreServices): void {
    this.coreServices = {
      ...this.coreServices,
      ...services,
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
        const configManager = requireConfigManager(this.coreServices);
        const workingDirectory = configManager.getWorkingDirectory();
        if (!workingDirectory) {
          return { success: false, output: 'ACP manager requires an explicit working directory.' };
        }

        const task: SubagentTask = {
          description: String(args.description ?? ''),
          context: String(args.context ?? ''),
          tools: Array.isArray(args.tools) ? args.tools.map(String) : [],
          workingDirectory,
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

  public setSystemMessageRouter(router: Pick<SystemMessageRouter, 'low'> | null): void {
    this.systemMessageRouter = router;
  }

  public enqueueConversationFollowUp(item: ConversationFollowUpItem): void {
    this.followUpRuntime.enqueue(item);
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
   * Dispose long-lived runtime attachments owned by this orchestrator.
   *
   * Safe to call multiple times. Intended for process shutdown and tests that
   * construct transient orchestrators against a shared RuntimeEventBus.
   */
  public dispose(): void {
    this.abort();
    if (this.animInterval) {
      clearInterval(this.animInterval);
      this.animInterval = null;
    }
    this.isThinking = false;
    this.isStreaming = false;
    this.streamingInputTokens = 0;
    this.streamingOutputTokens = 0;
    if (this.detachReplay) {
      this.detachReplay();
      this.detachReplay = null;
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
    getSessionLineageTracker(this.coreServices, this.ownedSessionLineageTracker).setOriginalTask(text.slice(0, 200));

    await this.runTurn(text, content);

    // Process any messages queued while the LLM was thinking (iterative, not recursive)
    while (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift()!;
      await this.runTurn(next.text, next.content);
    }

    this.followUpRuntime.scheduleFlush();
  }

  private startThinking(estimatedInputTokens?: number): void {
    this.isThinking = true;
    this.thinkingFrame = 0; // Reset each turn so gradient starts clean and frame never grows unbounded
    this.streamingInputTokens = estimatedInputTokens ?? this.lastRequestInputTokens;
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
    const configManager = requireConfigManager(this.coreServices);
    const providerRegistry = requireProviderRegistry(this.coreServices);

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
    const idempotencyStore = getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore);
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
      emitTurnSubmitted(this.runtimeBus, createEmitterContext(this.sessionId, turnId), { turnId, prompt: text });
    }

    // Adaptive Execution Planner.
    // If the feature flag is enabled, score and select the execution strategy
    // before the turn proceeds. The selected strategy and reason code are
    // emitted for the Ops panel and logged for observability.
    maybeEmitAdaptivePlannerDecision(
      text,
      this.flagManager?.isEnabled('adaptive-execution-planner') ?? false,
      this.coreServices.adaptivePlanner ?? null,
      this.runtimeBus,
      (id) => createEmitterContext(this.sessionId, id),
      turnId,
    );
    // ────────────────────────────────────────────────────────────────────────

    // Pre-turn plan injection: if an active plan exists, inject its current state into
    // the conversation so the LLM can refer to it and update item statuses.
    const preTurnPlan = prepareConversationForTurn(
      this.conversation,
      providerRegistry,
      text,
      content,
      this.sessionId,
      this.coreServices.planManager ?? null,
    );

    this.turnStartMessageCount = this.conversation.getMessageCount();
    this.scrollToEnd(this.getViewportHeight());

    const initialEstimatedTokens = estimateConversationTokens(this.conversation.getMessagesForLLM());
    this.startThinking(estimateFreshTurnInputTokens(this.lastInputTokens, initialEstimatedTokens, text, content));

    try {
      await executeOrchestratorTurnLoop({
        conversation: this.conversation,
        toolRegistry: this.toolRegistry,
        getSystemPrompt: this.getSystemPrompt,
        getAbortSignal: () => this.abortController?.signal,
        hookDispatcher: this.hookDispatcher,
        requestRender: this.requestRender,
        runtimeBus: this.runtimeBus,
        agentManager: this.agentManager,
        configManager,
        providerRegistry,
        favoritesStore: this.coreServices.favoritesStore,
        cacheHitTracker: getCacheHitTracker(this.coreServices, this.ownedCacheHitTracker),
        helperModel: new HelperModel({ configManager, providerRegistry }),
        sessionId: this.sessionId,
        preTurnPlan,
        planManager: this.coreServices.planManager ?? null,
        text,
        content,
        turnId,
        emitterContext: (id) => createEmitterContext(this.sessionId, id),
        executeToolCalls: (id, calls) => this.executeToolCalls(id, calls),
        checkContextWindowPreflight: (id, model) => this.checkContextWindowPreflight(id, model),
        normalizeUsage,
        estimateFreshTurnInputTokens: (currentEstimatedTokens, nextText, nextContent) =>
          estimateFreshTurnInputTokens(this.lastInputTokens, currentEstimatedTokens, nextText, nextContent),
        getMessageQueueLength: () => this.messageQueue.length,
        isReconciliationEnabled: () => this.isReconciliationEnabled(),
        setPendingToolCalls: (calls) => { this._pendingToolCalls = calls; },
        setAutoSpawnTimeout: (timeout) => { this.autoSpawnTimeout = timeout; },
        setStreamingActive: (value) => { this.isStreaming = value; },
        setStreamingInputTokens: (value) => { this.streamingInputTokens = value; },
        addStreamingOutputTokens: (value) => { this.streamingOutputTokens += value; },
        setLastRequestInputTokens: (value) => { this.lastRequestInputTokens = value; },
        setLastInputTokens: (value) => { this.lastInputTokens = value; },
        markTurnFailed: () => { this._turnFailed = true; },
        usage: this.usage,
      });

      await handlePostTurnContextMaintenance({
        conversation: this.conversation,
        agentManager: this.agentManager,
        wrfcController: this.wrfcController,
        planManager: this.coreServices.planManager ?? null,
        sessionMemoryStore: this.coreServices.sessionMemoryStore ?? null,
        configManager,
        providerRegistry,
        sessionLineageTracker: getSessionLineageTracker(this.coreServices, this.ownedSessionLineageTracker),
        runtimeBus: this.runtimeBus,
        emitterContext: (id) => createEmitterContext(this.sessionId, id),
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
            emitStreamEnd(this.runtimeBus, createEmitterContext(this.sessionId, turnId), { turnId });
          }
        }
        // Remove any partial LLM response, keep user message but mark it cancelled
        this.conversation.removeMessagesAfter(this.turnStartMessageCount);
        this.conversation.markLastUserMessageCancelled();
        this.conversation.addSystemMessage('[Response cancelled]');
        if (this.runtimeBus) {
          emitTurnCancel(this.runtimeBus, createEmitterContext(this.sessionId, turnId), {
            turnId,
            reason: 'cancelled',
            stopReason: 'cancelled',
          });
        }
        return;
      }

      const error = err instanceof Error ? err : new Error(summarizeError(err));
      const msg = formatError(error, {
        ...(error instanceof ProviderError
          ? { provider: providerRegistry.getCurrentModel().provider, source: 'provider' as const }
          : {}),
      });
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
        emitTurnError(this.runtimeBus, createEmitterContext(this.sessionId, turnId), {
          turnId,
          error: summarizeError(error),
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
          getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore).markFailed(this.currentSubmissionKey);
        } else {
          getIdempotencyStore(this.coreServices, this.ownedIdempotencyStore).markComplete(this.currentSubmissionKey);
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
          if (this.systemMessageRouter) {
            this.systemMessageRouter.low(msg);
          } else {
            this.conversation.addSystemMessage(msg);
          }
        }
        this.requestRender();
      }
      this.followUpRuntime.scheduleFlush();
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
    const configManager = requireConfigManager(this.coreServices);
    const providerRegistry = requireProviderRegistry(this.coreServices);
    return checkContextWindowPreflight({
      conversation: this.conversation,
      requestRender: this.requestRender,
      hookDispatcher: this.hookDispatcher,
      configManager,
      providerRegistry,
      sessionId: this.sessionId,
      agentManager: this.agentManager,
      wrfcController: this.wrfcController,
      planManager: this.coreServices.planManager ?? null,
      sessionMemoryStore: this.coreServices.sessionMemoryStore ?? null,
      sessionLineageTracker: getSessionLineageTracker(this.coreServices, this.ownedSessionLineageTracker),
      runtimeBus: this.runtimeBus,
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
      isCompacting: this.isCompacting,
      setIsCompacting: (value) => { this.isCompacting = value; },
    }, turnId, model);
  }

  /**
   * Auto-spawn agents for a list of ready plan items under bounded orchestration policy.
   */
  private autoSpawnPendingItems(
    turnId: string,
    plan: ExecutionPlan,
    items: PlanItem[],
  ): string[] {
    const configManager = requireConfigManager(this.coreServices);
    const providerRegistry = requireProviderRegistry(this.coreServices);
    return autoSpawnPendingItems(
      this.conversation,
      plan,
      items,
      this.agentManager,
      configManager,
      providerRegistry,
      this.runtimeBus,
      createEmitterContext(this.sessionId, turnId),
      this.coreServices.planManager ?? null,
    );
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
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
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
      emitterContext: (id) => createEmitterContext(this.sessionId, id),
    }, turnId, calls);
  }
}
