import type { ConversationManager } from './conversation.ts';
import type { ExecutionPlan } from './execution-plan.ts';
import { ConsecutiveErrorBreaker } from './circuit-breaker.ts';
import type { CacheHitTracker } from '../providers/cache-strategy.ts';
import type { ConfigManager } from '../config/manager.ts';
import { estimateConversationTokens, estimateTokens } from './context-compaction.ts';
import { ProviderError, isNonTransientProviderFailure } from '../types/errors.ts';
import { formatProviderError } from '../utils/error-display.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import type { ContentPart, LLMProvider, StreamDelta } from '../providers/interface.ts';
import type { HookEvent, HookResult } from '../hooks/types.ts';
import {
  emitOpsCacheMetrics,
  emitOpsHelperUsage,
  emitLlmResponseReceived,
  emitPreflightFail,
  emitPreflightOk,
  emitStreamDelta,
  emitStreamEnd,
  emitStreamStart,
  emitTurnError,
} from '../runtime/emitters/index.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { HelperModel } from '../config/helper-model.ts';
import type { ModelDefinition } from '../providers/registry.ts';
import type { FavoritesStore } from '../providers/favorites.ts';
import { logger } from '../utils/logger.ts';
import type { AgentManager } from '../tools/agent/index.ts';
import type { ExecutionPlanManager } from './execution-plan.ts';
import {
  emitMalformedToolUseWarning,
  handleFinalResponseOutcome,
  handleToolResponseOutcome,
  type ChatResponseWithReasoning,
} from './orchestrator-turn-helpers.ts';

const AUTO_SPAWN_FALLBACK_DELAY_MS = 5_000;

interface HookDispatcherLike {
  fire(event: HookEvent): Promise<HookResult>;
}

type EmitterContext = import('../runtime/emitters/index.ts').EmitterContext;

export interface OrchestratorTurnLoopContext {
  readonly conversation: ConversationManager;
  readonly toolRegistry: ToolRegistry;
  readonly getSystemPrompt: () => string;
  readonly getAbortSignal: () => AbortSignal | undefined;
  readonly hookDispatcher: HookDispatcherLike | null;
  readonly requestRender: () => void;
  readonly runtimeBus: RuntimeEventBus | null;
  readonly agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'getTokenLimitsForModel'>;
  readonly favoritesStore?: Pick<FavoritesStore, 'recordUsage'>;
  readonly cacheHitTracker: Pick<CacheHitTracker, 'getMetrics'>;
  readonly helperModel: HelperModel;
  readonly sessionId: string;
  readonly preTurnPlan: ExecutionPlan | null;
  readonly planManager: Pick<
    ExecutionPlanManager,
    'getActive' | 'getSummary' | 'getNextItems' | 'toMarkdown' | 'create' | 'save' | 'parseFromMarkdown' | 'replaceItems' | 'load' | 'updateItem'
  > | null;
  readonly text: string;
  readonly content?: ContentPart[];
  readonly turnId: string;
  readonly emitterContext: (turnId: string) => EmitterContext;
  readonly executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  readonly checkContextWindowPreflight: (turnId: string, model: ModelDefinition) => Promise<'ok' | 'compacted' | 'error'>;
  readonly normalizeUsage: (usage: Awaited<ReturnType<LLMProvider['chat']>>['usage']) => Awaited<ReturnType<LLMProvider['chat']>>['usage'];
  readonly estimateFreshTurnInputTokens: (
    currentEstimatedTokens: number,
    text: string,
    content?: ContentPart[],
  ) => number;
  readonly getMessageQueueLength: () => number;
  readonly isReconciliationEnabled: () => boolean;
  readonly setPendingToolCalls: (calls: ToolCall[]) => void;
  readonly setAutoSpawnTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;
  readonly setStreamingActive: (value: boolean) => void;
  readonly setStreamingInputTokens: (value: number) => void;
  readonly addStreamingOutputTokens: (value: number) => void;
  readonly setLastRequestInputTokens: (value: number) => void;
  readonly setLastInputTokens: (value: number) => void;
  readonly markTurnFailed: () => void;
  readonly usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export async function executeOrchestratorTurnLoop(context: OrchestratorTurnLoopContext): Promise<void> {
  const helperModel = context.helperModel;
  const model = context.providerRegistry.getCurrentModel();
  const provider: LLMProvider = model.provider
    ? context.providerRegistry.get(model.provider)
    : context.providerRegistry.getForModel(model.id);
  const toolDefinitions = context.toolRegistry.getToolDefinitions();
  const streamEnabled = context.configManager.get('display.stream') as boolean;

  let continueLoop = true;
  const circuitBreaker = new ConsecutiveErrorBreaker();

  while (continueLoop) {
    let streamAccumulated = '';
    let reasoningAccumulated = '';
    let streamSessionStarted = false;
    const onDelta = (delta: StreamDelta) => {
      if (delta.content) {
        streamAccumulated += delta.content;
        if (streamEnabled) {
          context.conversation.updateStreamingBlock(streamAccumulated);
        }
      }
      if (delta.reasoning) {
        reasoningAccumulated += delta.reasoning;
      }
      if (delta.content || delta.reasoning) {
        context.addStreamingOutputTokens(Math.max(
          1,
          estimateTokens(delta.content ?? delta.reasoning ?? ''),
        ));
      }
      if (context.runtimeBus) {
        emitStreamDelta(context.runtimeBus, context.emitterContext(context.turnId), {
          turnId: context.turnId,
          content: delta.content ?? '',
          accumulated: streamAccumulated,
          ...(delta.reasoning !== undefined ? { reasoning: delta.reasoning } : {}),
          ...(delta.toolCalls !== undefined ? { toolCalls: delta.toolCalls } : {}),
        });
      }
      context.requestRender();
    };

    const preflightResult = await context.checkContextWindowPreflight(context.turnId, model);
    if (preflightResult === 'error') {
      if (streamEnabled) {
        context.setStreamingActive(false);
        context.conversation.finalizeStreamingBlock();
      }
      if (context.runtimeBus) {
        emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
        emitPreflightFail(context.runtimeBus, context.emitterContext(context.turnId), {
          turnId: context.turnId,
          reason: 'context window preflight failed',
          stopReason: 'context_overflow',
        });
      }
      context.markTurnFailed();
      break;
    }
    if (context.runtimeBus) {
      emitPreflightOk(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }

    context.setStreamingInputTokens(
      context.estimateFreshTurnInputTokens(
        estimateConversationTokens(context.conversation.getMessagesForLLM()),
        context.text,
        context.content,
      ),
    );

    if (streamEnabled) {
      context.setStreamingActive(true);
      context.conversation.startStreamingBlock();
    }
    if (context.runtimeBus) {
      emitStreamStart(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }
    streamSessionStarted = true;

    const tokenLimits = context.providerRegistry.getTokenLimitsForModel(model);

    if (context.hookDispatcher) {
      const preEvent: HookEvent = {
        path: 'Pre:llm:chat',
        phase: 'Pre',
        category: 'llm',
        specific: 'chat',
        sessionId: context.sessionId,
        timestamp: Date.now(),
        payload: { model: model.id, provider: model.provider, messageCount: context.conversation.getMessagesForLLM().length },
      };
      const preResult = await context.hookDispatcher.fire(preEvent);
      if (preResult.decision === 'deny') {
        context.conversation.addSystemMessage(preResult.reason ?? 'LLM call blocked by hook');
        if (context.runtimeBus) {
          emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
            turnId: context.turnId,
            error: preResult.reason ?? 'LLM call blocked by hook',
            stopReason: 'hook_denied',
          });
        }
        context.markTurnFailed();
        break;
      }
    }

    let response: Awaited<ReturnType<typeof provider.chat>>;
    try {
      response = await provider.chat({
        model: model.id,
        messages: context.conversation.getMessagesForLLM(),
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        systemPrompt: context.getSystemPrompt(),
        maxTokens: tokenLimits.maxOutputTokens,
        reasoningEffort: (() => {
          const configured = context.configManager.get('provider.reasoningEffort') as string | undefined;
          if (configured) return configured as 'instant' | 'low' | 'medium' | 'high';
          return model.capabilities.reasoning ? 'medium' : undefined;
        })(),
        signal: context.getAbortSignal(),
        onDelta,
      });
    } catch (chatErr) {
      if (streamEnabled) {
        context.setStreamingActive(false);
        context.conversation.finalizeStreamingBlock();
      }
      if (streamSessionStarted && context.runtimeBus) {
        emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
      }
      if (chatErr instanceof ProviderError && chatErr.statusCode === 429 && model.provider === 'synthetic' && model.tier !== 'free') {
        context.conversation.addSystemMessage(
          `All providers for ${model.displayName} are currently exhausted.\n`
          + `Options:\n`
          + `  • Wait a few minutes for the rate limit to reset and retry\n`
          + `  • Switch to a different model with /model\n`
          + `  • Switch to a free model via /model and selecting the free tier`,
        );
        if (context.runtimeBus) {
          emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
            turnId: context.turnId,
            error: 'All providers for the selected synthetic model are exhausted',
            stopReason: 'provider_exhausted',
          });
        }
        context.markTurnFailed();
        context.requestRender();
        break;
      }
      if (context.hookDispatcher) {
        context.hookDispatcher.fire({
          path: 'Fail:llm:chat',
          phase: 'Fail',
          category: 'llm',
          specific: 'chat',
          sessionId: context.sessionId,
          timestamp: Date.now(),
          payload: { model: model.id, provider: model.provider, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
        }).catch(() => {});
      }
      throw chatErr;
    }

    if (streamEnabled) {
      context.setStreamingActive(false);
      context.conversation.finalizeStreamingBlock();
    }
    if (streamSessionStarted && context.runtimeBus) {
      emitStreamEnd(context.runtimeBus, context.emitterContext(context.turnId), { turnId: context.turnId });
    }

    response = {
      ...response,
      usage: context.normalizeUsage(response.usage),
    };

    void context.favoritesStore?.recordUsage(model.id);
    context.usage.input += response.usage.inputTokens;
    context.usage.output += response.usage.outputTokens;
    context.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
    context.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;

    const cacheMetrics = context.cacheHitTracker.getMetrics();
    if (cacheMetrics.turns > 0 && context.runtimeBus) {
      emitOpsCacheMetrics(context.runtimeBus, context.emitterContext(context.turnId), {
        hitRate: cacheMetrics.hitRate,
        cacheReadTokens: cacheMetrics.cacheReadTokens,
        cacheWriteTokens: cacheMetrics.cacheWriteTokens,
        totalInputTokens: cacheMetrics.totalInputTokens,
        turns: cacheMetrics.turns,
      });
    }

    const helperUsage = helperModel.getUsage();
    if (helperUsage.calls > 0 && context.runtimeBus) {
      emitOpsHelperUsage(context.runtimeBus, context.emitterContext(context.turnId), {
        inputTokens: helperUsage.inputTokens,
        outputTokens: helperUsage.outputTokens,
        calls: helperUsage.calls,
      });
    }

    const hitRateThreshold = context.configManager.get('cache.hitRateWarningThreshold');
    if (
      cacheMetrics.turns >= 5
      && cacheMetrics.hitRate < hitRateThreshold
      && context.configManager.get('cache.monitorHitRate')
    ) {
      logger.info(`[Cache] Low hit rate: ${(cacheMetrics.hitRate * 100).toFixed(0)}% over ${cacheMetrics.turns} turns`);
    }

    context.setLastRequestInputTokens(response.usage.inputTokens);
    context.setLastInputTokens(
      response.usage.inputTokens
      + (response.usage.cacheReadTokens ?? 0)
      + (response.usage.cacheWriteTokens ?? 0),
    );

    if (context.runtimeBus) {
      emitLlmResponseReceived(context.runtimeBus, context.emitterContext(context.turnId), {
        turnId: context.turnId,
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

    if (context.hookDispatcher) {
      context.hookDispatcher.fire({
        path: 'Post:llm:chat',
        phase: 'Post',
        category: 'llm',
        specific: 'chat',
        sessionId: context.sessionId,
        timestamp: Date.now(),
        payload: {
          model: model.id,
          provider: model.provider,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          toolCallCount: response.toolCalls.length,
        },
      }).catch(() => {});
    }

    const reasoningForMsg = reasoningAccumulated || undefined;
    const reasoningSummaryForMsg = response.reasoningSummary || undefined;

    if (response.stopReason === 'tool_use' && response.toolCalls.length === 0) {
      emitMalformedToolUseWarning({
        conversation: context.conversation,
        providerRegistry: context.providerRegistry,
        runtimeBus: context.runtimeBus,
        emitterContext: (id) => context.emitterContext(id),
        turnId: context.turnId,
        isReconciliationEnabled: context.isReconciliationEnabled(),
      });
    }

    if (response.toolCalls.length > 0) {
      const enrichedResponse: ChatResponseWithReasoning = {
        ...response,
        reasoning: reasoningForMsg,
        reasoningSummary: reasoningSummaryForMsg,
      };
      const results = await handleToolResponseOutcome({
        conversation: context.conversation,
        agentManager: context.agentManager,
        planManager: context.planManager,
        configManager: context.configManager,
        providerRegistry: context.providerRegistry,
        runtimeBus: context.runtimeBus,
        emitterContext: (id) => context.emitterContext(id),
        turnId: context.turnId,
        response: enrichedResponse,
        executeToolCalls: (id, calls) => context.executeToolCalls(id, calls),
        setPendingToolCalls: (calls) => { context.setPendingToolCalls(calls); },
        messageQueueLength: context.getMessageQueueLength(),
        requestRender: context.requestRender,
        sessionId: context.sessionId,
      });

      const allFailed = results.results.length > 0 && results.results.every((result) => result.success === false);
      if (allFailed) {
        const breakerResult = circuitBreaker.recordAllFailed();
        logger.warn(`Orchestrator: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
        if (breakerResult === 'break') {
          logger.warn(`Orchestrator: circuit breaker tripped at ${circuitBreaker.consecutiveErrors} consecutive all-error turns`);
          context.conversation.addSystemMessage(
            `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. `
            + `The loop is stopping to prevent an infinite failure cycle. `
            + `Please reassess your approach and try a completely different strategy.`,
          );
          if (context.runtimeBus) {
            emitTurnError(context.runtimeBus, context.emitterContext(context.turnId), {
              turnId: context.turnId,
              error: 'Consecutive all-failed tool turns tripped the circuit breaker',
              stopReason: 'tool_loop_circuit_breaker',
            });
          }
          context.markTurnFailed();
          continueLoop = false;
        } else if (breakerResult === 'warn') {
          context.conversation.addSystemMessage(
            `WARNING: You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. `
            + `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, `
            + `then try a completely different strategy.`,
          );
        }
      } else if (results.results.length > 0) {
        circuitBreaker.recordSuccess();
      }
      continueLoop = results.continueLoop;
      continue;
    }

    const enrichedResponse: ChatResponseWithReasoning = {
      ...response,
      reasoning: reasoningForMsg,
      reasoningSummary: reasoningSummaryForMsg,
    };
    continueLoop = handleFinalResponseOutcome({
      conversation: context.conversation,
      agentManager: context.agentManager,
      planManager: context.planManager,
      configManager: context.configManager,
      providerRegistry: context.providerRegistry,
      runtimeBus: context.runtimeBus,
      emitterContext: (id) => context.emitterContext(id),
      turnId: context.turnId,
      response: enrichedResponse,
      preTurnPlan: context.preTurnPlan,
      requestRender: context.requestRender,
      setAutoSpawnTimeout: (timeout) => { context.setAutoSpawnTimeout(timeout); },
      autoSpawnTimeoutMs: AUTO_SPAWN_FALLBACK_DELAY_MS,
      sessionId: context.sessionId,
    });
  }
}
