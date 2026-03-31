import type { ConversationManager } from './conversation.ts';
import type { EventBus } from './event-bus.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import { PermissionError, ProviderError, ToolError, isNonTransientProviderFailure } from '../types/errors.ts';
import type { HookEvent, HookResult } from '../hooks/types.ts';
import { formatProviderError } from '../utils/error-display.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { ModelDefinition } from '../providers/registry.ts';
import type { LLMProvider, StreamDelta, ContentPart } from '../providers/interface.ts';
import { config, configManager, DEFAULT_CONFIG } from '../config/index.ts';
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
import { shouldAutoCompact, estimateConversationTokens, getCompactionThreshold } from './context-compaction.ts';
import type { CompactionContext } from './context-compaction.ts';
import { sessionMemoryStore } from './session-memory.ts';
import { sessionLineageTracker } from './session-lineage.ts';
import { getCatalog } from '../providers/model-catalog.ts';
import { recordUsage } from '../providers/favorites.ts';
import { EventReplayQueue } from './event-replay.ts';
import { AgentManager } from '../tools/agent/index.ts';
import type { AgentInput } from '../tools/agent/schema.ts';
import { WrfcController } from '../agents/wrfc-controller.ts';
import { THINKING_SPINNER_FRAMES } from '../renderer/progress.ts';
import { randomUUID } from 'node:crypto';

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

  /** Event replay queue — ensures model acknowledges significant events */
  private readonly replayQueue: EventReplayQueue;

  /** Cleanup function returned by EventReplayQueue.attachTo() */
  private detachReplay: (() => void) | null = null;

  constructor(
    private bus: EventBus,
    private conversation: ConversationManager,
    private getViewportHeight: () => number,
    private scrollToEnd: (vHeight: number) => void,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private getSystemPrompt: () => string = () => '',
    private hookDispatcher: HookDispatcherLike | null = null,
  ) {
    this.replayQueue = new EventReplayQueue(bus);
    this.detachReplay = EventReplayQueue.attachTo(bus, this.replayQueue);
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
      this.bus.emit('render:request');
      return;
    }

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
      this.bus.emit('render:request');
    }, 80);
    this.bus.emit('render:request');
  }

  private stopThinking(): void {
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = null;
    this.abortController = null;
    this.isThinking = false;
    this.streamingInputTokens = 0;
    this.streamingOutputTokens = 0;
    this.scrollToEnd(this.getViewportHeight());
    this.bus.emit('render:request');
  }

  private async runTurn(text: string, content?: ContentPart[]): Promise<void> {
    const turnStartTime = Date.now();
    this.bus.emit('turn:start', { prompt: text });

    // Pre-turn plan injection: if an active plan exists, inject its current state into
    // the conversation so the LLM can refer to it and update item statuses.
    const preTurnPlan = planManager.getActive();
    if (preTurnPlan) {
      const planMd = planManager.toMarkdown(preTurnPlan);
      this.conversation.addSystemMessage(
        `## Current Execution Plan\n${planMd}\n\nRefer to this plan. Update item statuses as you complete work.`
      );
    }

    // Capability check: if model doesn't support multimodal, strip images and warn
    if (content && content.some(p => p.type === 'image')) {
      const model = providerRegistry.getCurrentModel();
      if (!model.capabilities.multimodal) {
        this.conversation.addSystemMessage(
          `Warning: ${model.displayName} does not support image input. Images have been removed from this message.`
        );
        // Keep only text parts
        const textOnly = content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => p.text)
          .join('');
        this.conversation.addUserMessage(textOnly || text);
      } else {
        this.conversation.addUserMessage(content);
      }
    } else {
      this.conversation.addUserMessage(content ?? text);
    }

    this.turnStartMessageCount = this.conversation.getMessageCount();
    this.scrollToEnd(this.getViewportHeight());

    // ── Intent classification + plan injection ──────────────────────────────
    // Run heuristic classifier on the plain-text message. If it looks like a
    // project-level task (confidence > 0.5), inject a system instruction so
    // the model knows to create a spec + execution plan first.
    // Skip classification when an active plan already exists — plan implies project mode.
    const activePlan = planManager.getActive();
    if (!activePlan) {
      const classification = classifyIntent(text);
      if (classification.intent === 'project' && classification.confidence > 0.5) {
        this.conversation.addSystemMessage(
          '[Project mode] This looks like a multi-step project task. ' +
          'Before executing, write a brief spec (goals, constraints, non-goals) ' +
          'and an execution plan (phases and tasks). ' +
          'Use the execution plan format: ## Phase [STATUS] / - [x] Task — STATUS.'
        );
      }
    }

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
              this.bus.emit('turn:stream-delta', {
                content: delta.content ?? '',
                accumulated: streamAccumulated,
                ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}),
                ...(delta.toolCalls !== undefined ? { toolCalls: delta.toolCalls } : {}),
              });
              this.bus.emit('render:request');
            }
          : undefined;

        if (onDelta) {
          this.isStreaming = true;
          this.conversation.startStreamingBlock();
          this.bus.emit('turn:stream-start');
        }

        // ── Context window pre-flight check ─────────────────────────────────
        // Before calling the provider, verify the request fits within the model's
        // context window. Auto-compact if enabled and threshold exceeded, otherwise
        // surface a clear error with token counts and suggest alternatives.
        // NOTE: Pre-flight compaction (compact-then-retry) and post-turn compaction
        // (compact after a successful turn, lines ~497+) share the same underlying
        // conversation.compact() mechanism but serve different triggers.
        const preflightResult = await this.checkContextWindowPreflight(model);
        if (preflightResult === 'error') {
          // Error message already added to conversation; clean up streaming block
          if (onDelta) {
            this.isStreaming = false;
            this.conversation.finalizeStreamingBlock();
            this.bus.emit('turn:stream-end');
          }
          this.bus.emit('turn:complete', { response: '' });
          continueLoop = false;
          break;
        }
        // preflightResult === 'ok' or 'compacted' — proceed with chat call

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
            this.bus.emit('turn:stream-end');
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
            this.bus.emit('turn:complete', { response: '' });
            this.bus.emit('render:request');
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
          this.bus.emit('turn:stream-end');
        }

        void recordUsage(model.id);
        this.usage.input += response.usage.inputTokens;
        this.usage.output += response.usage.outputTokens;
        this.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
        this.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;
        this.lastInputTokens = response.usage.inputTokens
          + (response.usage.cacheReadTokens ?? 0)
          + (response.usage.cacheWriteTokens ?? 0);

        this.bus.emit('turn:llm-response', {
          content: response.content,
          toolCalls: response.toolCalls,
        });

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

        if (response.toolCalls.length > 0) {
          // Add assistant turn (may include both content and tool calls)
          this.conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, reasoningContent: reasoningForMsg, reasoningSummary: reasoningSummaryForMsg, usage: response.usage, model: model.displayName, provider: model.provider });

          // Execute tools and collect results
          const results = await this.executeToolCalls(response.toolCalls);

          // Add tool results — LLM sees them on next iteration
          this.conversation.addToolResults(results);

          // --- Consecutive error circuit breaker ---
          // Count failures in this batch of tool results
          const allFailed = results.length > 0 && results.every(r => r.success === false);
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
              this.bus.emit('turn:complete', { response: '' });
              continueLoop = false;
            } else if (cbResult === 'warn') {
              this.conversation.addSystemMessage(
                `WARNING: You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
                `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
                `then try a completely different strategy.`
              );
            }
          } else if (results.length > 0) {
            // At least one success — reset the counter
            circuitBreaker.recordSuccess();
          }

          // If agents were spawned, end the turn — agents run in background, WRFC handles quality.
          // Also end if user typed something during tool execution.
          const spawnedAgents = response.toolCalls.some((tc: ToolCall) => {
            const mode = (tc.arguments as Record<string, unknown>).mode;
            return tc.name === 'agent' && (mode === 'spawn' || mode === 'batch-spawn');
          });
          if (spawnedAgents || this.messageQueue.length > 0) {
            // Harness-driven auto-spawn: if the plan has pending items with met dependencies,
            // spawn agents for them directly — don't wait for the model to do it.
            if (spawnedAgents) {
              const activePlan = planManager.getActive();
              if (activePlan) {
                const summary = planManager.getSummary(activePlan);
                const nextItems = planManager.getNextItems(activePlan);

                if (nextItems.length > 0) {
                  const autoSpawnedDescs = this.autoSpawnPendingItems(activePlan, nextItems);

                  if (autoSpawnedDescs.length > 0) {
                    this.conversation.addSystemMessage(
                      `[Plan] Auto-spawned ${autoSpawnedDescs.length} agent(s) for remaining plan items: ${autoSpawnedDescs.join(', ')}. Plan progress: ${summary}.`
                    );
                  } else {
                    // Auto-spawn failed for all items — fall back to nudge so model can try
                    const nextDesc = nextItems.map(i => i.description).join(', ');
                    this.conversation.addSystemMessage(
                      `Plan progress: ${summary}. Next items ready: ${nextDesc}. Continue spawning agents for remaining work.`
                    );
                  }
                } else {
                  this.conversation.addSystemMessage(
                    `Plan progress: ${summary}. All items are accounted for.`
                  );
                }
              } else {
                this.conversation.addSystemMessage(
                  'You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.'
                );
              }
            }
            this.bus.emit('turn:complete', { response: response.content });
            continueLoop = false;
          } else if (planManager.getActive()) {
            // Non-agent tool calls completed while a plan is active — prompt the LLM to update statuses.
            this.conversation.addSystemMessage(
              'Update the execution plan to reflect completed work. Mark items as COMPLETE or IN_PROGRESS with the agent ID.'
            );
          }

          // Loop continues: send results back to LLM
        } else {
          // No tool calls — final response
          this.conversation.addAssistantMessage(response.content, { reasoningContent: reasoningForMsg, reasoningSummary: reasoningSummaryForMsg, usage: response.usage, model: model.displayName, provider: model.provider });
          this.bus.emit('turn:complete', { response: response.content });
          continueLoop = false;

          // Plan parsing: if the active plan has no items yet and the model's response contains
          // a plan in markdown format, parse it and immediately auto-spawn agents.
          if (preTurnPlan && preTurnPlan.awaitingPlan === true && response.content.includes('## Phase')) {
            const parsed = planManager.parseFromMarkdown(response.content);
            if (parsed.items && parsed.items.length > 0) {
              planManager.replaceItems(preTurnPlan.id, parsed.items);
              // Clear the awaitingPlan flag — the plan is now populated
              const filledPlan = planManager.load(preTurnPlan.id);
              if (filledPlan) {
                filledPlan.awaitingPlan = false;
                planManager.save(filledPlan);
              }
              const updatedPlan = planManager.getActive();
              if (updatedPlan) {
                const nextItems = planManager.getNextItems(updatedPlan);
                if (nextItems.length > 0) {
                  const spawned = this.autoSpawnPendingItems(updatedPlan, nextItems);
                  if (spawned.length > 0) {
                    this.conversation.addSystemMessage(
                      `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Auto-spawned ${spawned.length} agent(s) for items with no blockers: ${spawned.join(', ')}.`
                    );
                    this.bus.emit('render:request');
                  } else {
                    this.conversation.addSystemMessage(
                      `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Spawn agents for the items with no blockers to begin execution.`
                    );
                  }
                } else {
                  this.conversation.addSystemMessage(
                    `[Plan] Parsed ${parsed.items.length} item(s) from your plan. No items are ready to start — check dependencies.`
                  );
                }
                // Skip the timeout fallback since we already handled spawning
                return;
              }
            }
          }

          // Timeout fallback: if the model ended its turn without spawning agents but there
          // are pending plan items with met dependencies, auto-spawn them after a short delay.
          // This handles weak/free models that stop responding after the first response.
          const pendingPlan = planManager.getActive();
          if (pendingPlan) {
            const pendingItems = planManager.getNextItems(pendingPlan);
            if (pendingItems.length > 0) {
              this.autoSpawnTimeout = setTimeout(() => {
                this.autoSpawnTimeout = null;
                const stillActivePlan = planManager.getActive();
                if (!stillActivePlan) return;
                const stillPending = planManager.getNextItems(stillActivePlan);
                if (stillPending.length === 0) return;

                const spawned = this.autoSpawnPendingItems(stillActivePlan, stillPending);

                if (spawned.length > 0) {
                  this.conversation.addSystemMessage(
                    `[Plan] Timeout fallback auto-spawned ${spawned.length} agent(s) for plan items the model did not address: ${spawned.join(', ')}.`
                  );
                  this.bus.emit('render:request');
                }
              }, AUTO_SPAWN_FALLBACK_DELAY_MS);
            }
          }
        }
      }

      // Context usage check: auto-compact when threshold exceeded, otherwise warn.
      // Uses model-limits data for context window (OpenRouter-sourced when available,
      // falls back to static registry value).
      const totalTokens = this.lastInputTokens;
      const currentModel = providerRegistry.getCurrentModel();
      const maxTokens = getContextWindowForModel(currentModel);
      if (maxTokens > 0) {
        const usagePct = Math.round((totalTokens / maxTokens) * 100);
        // Context-window-aware threshold: larger windows have more headroom, so trigger
        // compaction earlier as a percentage; smaller windows need earlier intervention
        // to leave room for the LLM-assisted extraction calls during compaction.
        // Threshold 0 = disabled (existing convention).
        const configuredThreshold = configManager.get('behavior.autoCompactThreshold') as number;
        // Scale threshold down for smaller context windows using getCompactionThreshold.
        // Threshold 0 = disabled (existing convention).
        const effectiveThreshold = configuredThreshold <= 0
          ? configuredThreshold // disabled — preserve 0
          : Math.min(configuredThreshold, getCompactionThreshold(maxTokens));
        const bracket = Math.floor(usagePct / 10) * 10;

        if (
          shouldAutoCompact({
            currentTokens: totalTokens,
            contextWindow: maxTokens,
            threshold: effectiveThreshold,
            isCompacting: this.isCompacting,
          })
        ) {
          // Auto-compact: threshold exceeded, perform compaction in background
          this.isCompacting = true;
          this.conversation.addSystemMessage(
            `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Auto-compacting conversation...`
          );
          this.bus.emit('context:warning', { usage: usagePct, threshold: effectiveThreshold });
          this.bus.emit('render:request');

          // Pre:compact:auto hook — await to honour deny decisions
          let skipAutoCompact = false;
          if (this.hookDispatcher) {
            const preAutoResult = await this.hookDispatcher.fire({
              path: 'Pre:compact:auto',
              phase: 'Pre',
              category: 'compact',
              specific: 'auto',
              sessionId: this.sessionId,
              timestamp: Date.now(),
              payload: { trigger: 'auto', usagePct, totalTokens, maxTokens, threshold: effectiveThreshold },
            }).catch((err: unknown) => { logger.debug('Pre:compact:auto hook error', { error: String(err) }); return { ok: true } as import('../hooks/types.ts').HookResult; });
            if (preAutoResult.decision === 'deny') {
              this.isCompacting = false;
              skipAutoCompact = true;
              logger.info('Orchestrator: Pre:compact:auto denied by hook — skipping auto-compact', { reason: preAutoResult.reason });
            }
          }

          // Build v2 compaction context from live data sources
          const agentManager = AgentManager.getInstance();
          const wrfcController = WrfcController.getInstance();
          const compactionCtx: CompactionContext = {
            messages: this.conversation.getMessagesForLLM(),
            sessionMemories: sessionMemoryStore.list(),
            lineageEntries: sessionLineageTracker.getEntries(),
            agents: agentManager.list().filter(a => a.status === 'running' || a.status === 'pending'),
            wrfcChains: wrfcController.listChains(),
            activePlan: planManager.getActive(),
            compactionCount: sessionLineageTracker.getCompactionCount(),
            contextWindow: maxTokens,
            trigger: 'auto',
            extractionModelId: currentModel.id,
            extractionProvider: currentModel.provider,
          };

          // Run compaction without blocking current turn completion
          if (!skipAutoCompact) void this.conversation.compact(
            providerRegistry,
            currentModel.id,
            10,
            'auto',
            currentModel.provider,
            compactionCtx,
          ).then(() => {
            this.isCompacting = false;
            this.lastWarningBracket = 0; // Reset so warnings work after compaction
            this.conversation.addSystemMessage(
              'Context auto-compacted. Conversation history summarized to free context window.'
            );
            this.bus.emit('render:request');
            logger.info('Orchestrator: auto-compact complete', {
              modelId: currentModel.id,
              usagePct,
              threshold: effectiveThreshold,
            });
            // Post:compact:auto hook (fire-and-forget)
            if (this.hookDispatcher) {
              this.hookDispatcher.fire({
                path: 'Post:compact:auto',
                phase: 'Post',
                category: 'compact',
                specific: 'auto',
                sessionId: this.sessionId,
                timestamp: Date.now(),
                payload: { trigger: 'auto', usagePct, totalTokens, maxTokens, threshold: effectiveThreshold },
              }).catch((err: unknown) => { logger.debug('Post:compact:auto hook error', { error: String(err) }); });
            }
          }).catch((err: unknown) => {
            this.isCompacting = false;
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('Orchestrator: auto-compact failed', { error: msg });
            this.conversation.addSystemMessage(
              `Auto-compact failed: ${msg}. Use /compact to retry manually.`
            );
            this.bus.emit('render:request');
            // Fail:compact:auto hook (fire-and-forget)
            if (this.hookDispatcher) {
              this.hookDispatcher.fire({
                path: 'Fail:compact:auto',
                phase: 'Fail',
                category: 'compact',
                specific: 'auto',
                sessionId: this.sessionId,
                timestamp: Date.now(),
                payload: { trigger: 'auto', usagePct, totalTokens, maxTokens, threshold: effectiveThreshold, error: msg },
              }).catch((err: unknown) => { logger.debug('Fail:compact:auto hook error', { error: String(err) }); });
            }
          });
        } else if (usagePct >= Math.max(effectiveThreshold - 10, 50) && bracket > this.lastWarningBracket) {
          // Warning zone: approaching threshold but not yet compacting
          this.lastWarningBracket = bracket;
          this.conversation.addSystemMessage(
            `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Auto-compact will trigger at ${effectiveThreshold}%.`
          );
          this.bus.emit('context:warning', { usage: usagePct, threshold: effectiveThreshold });
          this.bus.emit('render:request');
        }
      }
    } catch (err: unknown) {
      if (this.abortController?.signal.aborted) {
        // Clean up streaming block if one was active when aborted
        if (this.isStreaming) {
          this.isStreaming = false;
          this.conversation.finalizeStreamingBlock();
          this.bus.emit('turn:stream-end');
        }
        // Remove any partial LLM response, keep user message but mark it cancelled
        this.conversation.removeMessagesAfter(this.turnStartMessageCount);
        this.conversation.markLastUserMessageCancelled();
        this.conversation.addSystemMessage('[Response cancelled]');
        this.bus.emit('turn:error', { error: new Error('Cancelled') });
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error instanceof ProviderError ? formatProviderError(error) : `Error: ${error.message}`;
      this.conversation.addSystemMessage(msg);
      // Graceful degradation — suggest alternative when provider fails non-transiently
      const autoSwitch = configManager.get('behavior.suggestAlternativeOnProviderFail') as boolean;
      if (autoSwitch && isNonTransientProviderFailure(err)) {
        const currentModel = providerRegistry.getCurrentModel();
        const alt = currentModel ? providerRegistry.findAlternativeModel(currentModel.id) : null;
        if (alt) {
          this.conversation.addSystemMessage(`[Provider] ${currentModel?.provider ?? 'Unknown'} failed. Alternative available: ${alt.displayName} (${alt.provider}). Use /model to switch.`);
        }
      }
      this.bus.emit('turn:error', { error });
    } finally {
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
        this.bus.emit('render:request');
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
    model: ModelDefinition,
  ): Promise<'ok' | 'compacted' | 'error'> {
    const catalog = getCatalog();
    const catalogModel = catalog.getModel(model.id);
    const contextWindow = catalogModel?.context ?? getContextWindowForModel(model);

    if (contextWindow <= 0) {
      // Unknown context window — can't validate, allow through
      return 'ok';
    }

    const messages = this.conversation.getMessagesForLLM();
    const estimatedTokens = estimateConversationTokens(messages);

    if (estimatedTokens <= contextWindow) {
      return 'ok';
    }

    // Request exceeds context window — try auto-compact first
    const threshold = configManager.get('behavior.autoCompactThreshold') as number;
    // threshold > 0 means auto-compact is active (0 = disabled by convention).
    // threshold = 100 is valid: compact only when context is completely full.
    const autoCompactEnabled = threshold > 0;

    if (autoCompactEnabled && !this.isCompacting) {
      logger.info('Orchestrator: context window pre-flight — auto-compacting before chat call', {
        modelId: model.id,
        estimatedTokens,
        contextWindow,
      });

      this.isCompacting = true;
      this.conversation.addSystemMessage(
        `Context pre-check: request (~${Math.round(estimatedTokens / 1000)}K tokens) exceeds ${model.displayName} context window (${Math.round(contextWindow / 1000)}K). Auto-compacting...`
      );
      this.bus.emit('render:request');

      // Pre:compact:preflight hook — check for deny to skip compaction
      if (this.hookDispatcher) {
        const preResult = await this.hookDispatcher.fire({
          path: 'Pre:compact:preflight',
          phase: 'Pre',
          category: 'compact',
          specific: 'preflight',
          sessionId: this.sessionId,
          timestamp: Date.now(),
          payload: { trigger: 'preflight', estimatedTokens, contextWindow },
        }).catch((err: unknown) => { logger.debug('Pre:compact:preflight hook error', { error: String(err) }); return { ok: true } as import('../hooks/types.ts').HookResult; });
        if (preResult.decision === 'deny') {
          this.isCompacting = false;
          logger.info('Orchestrator: Pre:compact:preflight denied by hook — skipping preflight compact', { reason: preResult.reason });
          return 'ok';
        }
      }

      try {
        const preflightCtx: CompactionContext = {
          messages,
          sessionMemories: sessionMemoryStore.list(),
          lineageEntries: sessionLineageTracker.getEntries(),
          agents: AgentManager.getInstance().list().filter(a => a.status === 'running' || a.status === 'pending'),
          wrfcChains: WrfcController.getInstance().listChains(),
          activePlan: planManager.getActive(),
          compactionCount: sessionLineageTracker.getCompactionCount(),
          contextWindow,
          trigger: 'auto',
          extractionModelId: model.id,
          extractionProvider: model.provider,
        };
        await this.conversation.compact(
          providerRegistry,
          model.id,
          10,
          'auto',
          model.provider,
          preflightCtx,
        );
        this.conversation.addSystemMessage('Context compacted. Retrying request...');
        // Post:compact:preflight hook (fire-and-forget)
        if (this.hookDispatcher) {
          this.hookDispatcher.fire({
            path: 'Post:compact:preflight',
            phase: 'Post',
            category: 'compact',
            specific: 'preflight',
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { trigger: 'preflight', estimatedTokens, contextWindow },
          }).catch((err: unknown) => { logger.debug('Post:compact:preflight hook error', { error: String(err) }); });
        }
      } catch (compactErr) {
        const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
        logger.error('Orchestrator: pre-flight compact failed', { error: msg });
        this.conversation.addSystemMessage(`Auto-compact failed: ${msg}.`);
        // Fail:compact:preflight hook (fire-and-forget)
        if (this.hookDispatcher) {
          this.hookDispatcher.fire({
            path: 'Fail:compact:preflight',
            phase: 'Fail',
            category: 'compact',
            specific: 'preflight',
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { trigger: 'preflight', estimatedTokens, contextWindow, error: msg },
          }).catch((err: unknown) => { logger.debug('Fail:compact:preflight hook error', { error: String(err) }); });
        }
      } finally {
        this.isCompacting = false;
      }

      // Re-estimate after compaction
      const messagesAfter = this.conversation.getMessagesForLLM();
      const tokensAfter = estimateConversationTokens(messagesAfter);

      if (tokensAfter <= contextWindow) {
        return 'compacted';
      }

      // Still exceeds after compaction — fall through to error
      this.emitContextOverflowError(tokensAfter, contextWindow, model.displayName, catalogModel?.tier);
      return 'error';
    }

    // Auto-compact disabled or already compacting — emit error directly
    this.emitContextOverflowError(estimatedTokens, contextWindow, model.displayName, catalogModel?.tier);
    return 'error';
  }

  /**
   * Emit a user-facing error message when a request exceeds the model's context window,
   * including specific token counts and suggestions for alternative models.
   */
  private emitContextOverflowError(
    estimatedTokens: number,
    contextWindow: number,
    modelDisplayName: string,
    tier?: 'free' | 'paid' | 'subscription',
  ): void {
    const requestK = Math.round(estimatedTokens / 1000);
    const contextK = Math.round(contextWindow / 1000);
    const catalog = getCatalog();
    const alternatives = catalog.findLargerContextModels(contextWindow, tier, 3);

    let msg =
      `Request (~${requestK}K tokens) exceeds ${modelDisplayName} context window (${contextK}K). ` +
      `Use /compact to reduce context or switch to a larger model.`;

    if (alternatives.length > 0) {
      const altNames = alternatives
        .map(a => `${a.displayName} (${Math.round(a.context / 1000)}K)`)
        .join(', ');
      msg += ` Larger-context alternatives: ${altNames}.`;
    }

    logger.warn('Orchestrator: context window overflow', {
      estimatedTokens,
      contextWindow,
      modelDisplayName,
      alternatives: alternatives.map(a => a.id),
    });

    this.conversation.addSystemMessage(msg);
    this.bus.emit('turn:error', { error: new Error(msg) });
    this.bus.emit('render:request');
  }

  /**
   * Auto-spawn agents for a list of ready plan items, respecting agentRecursion
   * and maxGlobalAgents limits. Returns descriptions of successfully spawned items.
   */
  private autoSpawnPendingItems(
    plan: ExecutionPlan,
    items: PlanItem[],
  ): string[] {
    if (!configManager.get('danger.agentRecursion')) {
      return [];
    }

    const maxAgents = (configManager.get('danger.maxGlobalAgents') as number) || DEFAULT_CONFIG.danger.maxGlobalAgents;
    const agentManager = AgentManager.getInstance();
    const currentModel = providerRegistry.getCurrentModel();
    const spawned: string[] = [];
    let running = agentManager
      .list()
      .filter(a => a.status === 'running' || a.status === 'pending').length;

    for (const item of items) {
      if (running >= maxAgents) {
        this.conversation.addSystemMessage(
          `[Plan] Agent limit reached (${maxAgents}). Remaining items will be spawned as agents complete.`
        );
        break;
      }

      try {
        const spawnInput: AgentInput = {
          mode: 'spawn',
          task: item.description,
          template: 'engineer',
          model: currentModel.id,
        };
        const agentRecord = agentManager.spawn(spawnInput);
        planManager.updateItem(plan.id, item.id, 'in_progress', agentRecord.id);
        spawned.push(item.description);
        running++;
        logger.info('Orchestrator: Auto-spawned agent for plan item', {
          agentId: agentRecord.id,
          planItemId: item.id,
          description: item.description,
        });
      } catch (spawnErr) {
        logger.error('Orchestrator: Failed to auto-spawn agent for plan item', {
          planItemId: item.id,
          error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
        });
      }
    }

    return spawned;
  }

  private async executeToolCalls(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      // Check permission before announcing or executing the tool
      const approved = await this.permissionManager.check(call.name, call.arguments);
      if (!approved) {
        const err = new PermissionError(`Permission denied for tool '${call.name}'`);
        results.push({
          callId: call.id,
          success: false,
          error: err.message,
        });
        this.bus.emit('turn:tool-result', { callId: call.id, result: { callId: call.id, success: false, error: err.message } });
        continue;
      }

      this.bus.emit('turn:tool-executing', {
        callId: call.id,
        tool: call.name,
        args: call.arguments,
      });

      // --- Pre hook ---
      if (this.hookDispatcher) {
        try {
          const preEvent: HookEvent = {
            path: `Pre:tool:${call.name}`,
            phase: 'Pre',
            category: 'tool',
            specific: call.name,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, args: call.arguments },
          };
          const preResult = await this.hookDispatcher.fire(preEvent);
          if (preResult.decision === 'deny') {
            const deniedResult: ToolResult = {
              callId: call.id,
              success: false,
              error: preResult.reason ?? `Tool '${call.name}' denied by hook`,
            };
            this.bus.emit('turn:tool-result', { callId: call.id, result: deniedResult });
            results.push(deniedResult);
            continue;
          }
        } catch (hookErr) {
          logger.error('Orchestrator: Pre hook error', {
            tool: call.name,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }

      let result: ToolResult;
      try {
        result = await this.toolRegistry.execute(call.id, call.name, call.arguments);
      } catch (err) {
        const message =
          err instanceof ToolError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        result = {
          callId: call.id,
          success: false,
          error: message,
        };

        // --- Fail hook ---
        if (this.hookDispatcher) {
          try {
            const failEvent: HookEvent = {
              path: `Fail:tool:${call.name}`,
              phase: 'Fail',
              category: 'tool',
              specific: call.name,
              sessionId: this.sessionId,
              timestamp: Date.now(),
              payload: { callId: call.id, tool: call.name, error: message },
            };
            await this.hookDispatcher.fire(failEvent);
          } catch (hookErr) {
            logger.error('Orchestrator: Fail hook error', {
              tool: call.name,
              error: hookErr instanceof Error ? hookErr.message : String(hookErr),
            });
          }
        }
      }

      // --- Post hook (only on success) ---
      if (this.hookDispatcher && result.success === true) {
        try {
          const postEvent: HookEvent = {
            path: `Post:tool:${call.name}`,
            phase: 'Post',
            category: 'tool',
            specific: call.name,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { callId: call.id, tool: call.name, result },
          };
          await this.hookDispatcher.fire(postEvent);
        } catch (hookErr) {
          logger.error('Orchestrator: Post hook error', {
            tool: call.name,
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
          });
        }
      }

      this.bus.emit('turn:tool-result', { callId: call.id, result });

      // Post/Fail:file:write|edit hooks — fire for write/edit tools regardless of tool hook
      if (this.hookDispatcher && (call.name === 'write' || call.name === 'edit')) {
        const filePath = typeof call.arguments['path'] === 'string' ? call.arguments['path'] :
                         (Array.isArray(call.arguments['files']) ? JSON.stringify(call.arguments['files']) : '');
        if (result.success) {
          this.hookDispatcher.fire({
            path: `Post:file:${call.name}` as import('../hooks/types.ts').HookEventPath,
            phase: 'Post',
            category: 'file',
            specific: call.name,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { tool: call.name, path: filePath, callId: call.id },
          }).catch((err: unknown) => { logger.debug(`Post:file:${call.name} hook error`, { error: String(err) }); });
        } else {
          this.hookDispatcher.fire({
            path: `Fail:file:${call.name}` as import('../hooks/types.ts').HookEventPath,
            phase: 'Fail',
            category: 'file',
            specific: call.name,
            sessionId: this.sessionId,
            timestamp: Date.now(),
            payload: { tool: call.name, path: filePath, callId: call.id, error: result.error },
          }).catch((err: unknown) => { logger.debug(`Fail:file:${call.name} hook error`, { error: String(err) }); });
        }
      }

      results.push(result);
    }

    return results;
  }
}
