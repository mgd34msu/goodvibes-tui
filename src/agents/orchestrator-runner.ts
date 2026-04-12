import { ConversationManager } from '../core/conversation.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';
import { ConsecutiveErrorBreaker } from '../core/circuit-breaker.ts';
import { isRateLimitOrQuotaError, isContextSizeExceededError } from '../types/errors.ts';
import { AgentSession } from './session.ts';
import type { ProviderOptimizer } from '../providers/optimizer.ts';
import {
  estimateTokens,
  estimateConversationTokens,
  compactSmallWindow,
} from '../core/context-compaction.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { LLMProvider, StreamDelta } from '../providers/interface.ts';
import type { ToolResult } from '../types/tools.ts';
import type { ProcessManager } from '../tools/shared/process-manager.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { summarizeToolArgs } from './orchestrator-utils.ts';
import { buildLayeredOrchestratorSystemPrompt, buildOrchestratorSystemPrompt } from './orchestrator-prompts.ts';
import type { AgentMessageBus } from './message-bus.ts';
import type { KnowledgeService } from '../knowledge/index.ts';
import type { ArchetypeLoader } from './archetypes.ts';

const MAX_TURNS = 50;
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;
const CONTEXT_COMPACT_THRESHOLD = 0.85;
const MIN_WINDOW_FOR_LLM_COMPACT = 12_000;

type EmitterContext = import('../runtime/emitters/index.ts').EmitterContext;

export interface AgentOrchestratorRunContext {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly emitterContext: (agentId: string) => EmitterContext;
  readonly emitAgentProgress: (recordId: string, progress: string) => void;
  readonly emitOrchestrationProgress: (record: AgentRecord, progress: string) => void;
  readonly emitAgentStarted: (recordId: string) => void;
  readonly emitAgentCancelledEvent: (recordId: string, reason: string) => void;
  readonly emitOrchestrationCancelled: (record: AgentRecord, reason: string) => void;
  readonly emitAgentFailedEvent: (recordId: string, error: string, durationMs: number) => void;
  readonly emitOrchestrationFailed: (record: AgentRecord, error: string) => void;
  readonly emitAgentCompletedEvent: (recordId: string, durationMs: number, output: string, toolCallsMade: number) => void;
  readonly emitOrchestrationCompleted: (record: AgentRecord, output: string) => void;
  readonly emitStreamDelta: (recordId: string, content: string, accumulated: string) => void;
  readonly processManager?: ProcessManager;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages'>;
  readonly knowledgeService?: Pick<KnowledgeService, 'buildPromptPacketSync'>;
  readonly memoryRegistry?: Pick<import('../state/index.ts').MemoryRegistry, 'getAll' | 'searchSemantic'>;
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'>;
  readonly getFullRegistry: () => ToolRegistry;
  readonly buildScopedRegistry: (allowedNames: string[], fullRegistry: ToolRegistry) => ToolRegistry;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'get' | 'listModels' | 'getContextWindowForModel'>;
  readonly providerOptimizer?: Pick<ProviderOptimizer, 'recordFallbackTransition'>;
  readonly resolveProviderForRecord: (
    providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'get' | 'listModels'>,
    record: AgentRecord,
    currentModel: { id: string; provider: string },
  ) => { provider: LLMProvider; modelId: string; requestedModelId: string };
  readonly resolveFallbackModelRoutes: (
    providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getForModel'>,
    record: AgentRecord,
    primaryRequestedModelId: string,
  ) => Array<{ provider: LLMProvider; modelId: string; requestedModelId: string }>;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network error') ||
    msg.includes('network timeout') ||
    msg.includes('networkerror') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('dns') ||
    msg.includes('connection lost') ||
    msg.includes('epipe') ||
    msg.includes('ehostunreach')
  );
}

function applyContextWindowAwareness(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  modelId: string,
  modelWindow: number,
  conversation: ConversationManager,
  systemPrompt: string,
  toolTokens: number,
  turn: number,
): string {
  if (!(context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true)) {
    return systemPrompt;
  }

  if (modelWindow === 0) {
    logger.debug(`[agent-context-window-awareness] Context window is 0/unknown for model ${modelId}, skipping context validation`);
    return systemPrompt;
  }

  const messages = conversation.getMessagesForLLM();
  const msgTokens = estimateConversationTokens(messages);
  const sysTokens = estimateTokens(systemPrompt);
  const totalEstimate = msgTokens + sysTokens + toolTokens;
  const threshold = Math.floor(modelWindow * CONTEXT_COMPACT_THRESHOLD);

  if (totalEstimate <= threshold) {
    return systemPrompt;
  }

  logger.warn(
    `[AgentOrchestrator] context-window awareness: estimated ${totalEstimate} tokens exceeds ${threshold} (${Math.round(CONTEXT_COMPACT_THRESHOLD * 100)}% of ${modelWindow}) - compacting`,
    { agentId: record.id, turn, msgTokens, sysTokens, toolTokens, contextWindow: modelWindow },
  );
  record.progress = `Turn ${turn} · Compacting context…`;

  if (modelWindow <= MIN_WINDOW_FOR_LLM_COMPACT) {
    conversation.replaceMessagesForLLM(compactSmallWindow(messages));
  } else {
    conversation.replaceMessagesForLLM(compactSmallWindow(messages, Math.max(10, Math.floor(messages.length / 2))));
  }

  const remainingAfterMsgs = modelWindow - estimateConversationTokens(conversation.getMessagesForLLM()) - toolTokens;
  const currentSysTokens = estimateTokens(systemPrompt);
  if (currentSysTokens > remainingAfterMsgs * CONTEXT_COMPACT_THRESHOLD) {
    logger.warn(
      `[AgentOrchestrator] context-window awareness: system prompt (${currentSysTokens} tokens) too large for remaining window (${remainingAfterMsgs}) - applying layered trim`,
      { agentId: record.id },
    );
    return buildLayeredOrchestratorSystemPrompt(record, remainingAfterMsgs, context);
  }

  return systemPrompt;
}

function cleanupLeakedProcesses(
  processManager: ProcessManager | undefined,
  preAgentProcessIds: Set<string>,
): void {
  const pm = processManager;
  if (!pm) return;
  for (const p of pm.list()) {
    if (!preAgentProcessIds.has(p.id)) {
      pm.stop(p.id);
    }
  }
}

async function disposeSession(session: AgentSession): Promise<void> {
  try {
    await session.dispose();
  } catch {
    // non-fatal
  }
}

async function executeToolCalls(
  toolCalls: Awaited<ReturnType<LLMProvider['chat']>>['toolCalls'],
  toolRegistry: ToolRegistry,
  session: AgentSession,
  turn: number,
  record: AgentRecord,
  callHistory: string[],
  callHistoryWindow: number,
  context: AgentOrchestratorRunContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  for (const originalCall of toolCalls) {
    const call = { ...originalCall, arguments: { ...originalCall.arguments } };
    const argsSummary = summarizeToolArgs(call.arguments as Record<string, unknown>);
    record.progress = `Turn ${turn} · ${call.name}${argsSummary}`;
    record.toolCallCount++;
    context.emitAgentProgress(record.id, record.progress);
    context.emitOrchestrationProgress(record, record.progress);

    if (call.name === 'exec' || call.name === 'precision_exec') {
      call.arguments = structuredClone(call.arguments);
      const execArgs = call.arguments as Record<string, unknown>;
      if (Array.isArray(execArgs.commands)) {
        for (const cmd of execArgs.commands as Record<string, unknown>[]) {
          cmd.background = false;
          if (!cmd.timeout_ms) cmd.timeout_ms = 600_000;
        }
      }
      if (!execArgs.timeout_ms) execArgs.timeout_ms = 600_000;
    }

    const callSig = `${call.name}::${JSON.stringify(call.arguments)}`;
    try {
      const result = await toolRegistry.execute(call.id, call.name, call.arguments);
      results.push({ ...result, callId: call.id });
      session.appendMessage({
        type: 'tool_execution',
        turn,
        toolName: call.name,
        toolCallId: call.id,
        success: result.success !== false,
        args: JSON.stringify(call.arguments).slice(0, 500),
        resultPreview: (result.output ?? result.error ?? '').slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const toolErr = err instanceof Error ? err.message : String(err);
      results.push({
        callId: call.id,
        success: false,
        error: toolErr,
      });
      session.appendMessage({
        type: 'tool_execution',
        turn,
        toolName: call.name,
        toolCallId: call.id,
        success: false,
        args: JSON.stringify(call.arguments).slice(0, 500),
        resultPreview: toolErr.slice(0, 500),
        timestamp: new Date().toISOString(),
      });
    }

    callHistory.push(callSig);
    if (callHistory.length > callHistoryWindow) callHistory.shift();
  }

  return results;
}

async function finalizeAgentRun(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
): Promise<void> {
  const statusAfterLoop = (record as { status: string }).status;
  if (statusAfterLoop !== 'failed' && statusAfterLoop !== 'cancelled') {
    record.status = 'completed';
  }
  record.completedAt = Date.now();
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);

  if (context.runtimeBus && record.status !== 'failed' && statusAfterLoop !== 'cancelled') {
    context.emitAgentCompletedEvent(
      record.id,
      (record.completedAt ?? Date.now()) - record.startedAt,
      record.fullOutput ?? '',
      record.toolCallCount,
    );
    context.emitOrchestrationCompleted(record, record.fullOutput ?? '');
  }

  if (record.status === 'failed') {
    context.emitAgentFailedEvent(
      record.id,
      record.error ?? 'Circuit breaker tripped',
      Date.now() - record.startedAt,
    );
    context.emitOrchestrationFailed(record, record.error ?? 'Circuit breaker tripped');
    logger.error(`Agent ${record.id} circuit-breaker terminated`, { error: record.error, toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'failed',
      error: record.error,
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  } else if (statusAfterLoop === 'cancelled') {
    context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
    context.emitOrchestrationCancelled(record, 'Agent cancelled');
    logger.info(`Agent ${record.id} cancelled (detected post-loop)`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'cancelled',
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  } else {
    logger.info(`Agent ${record.id} completed`, { toolCallCount: record.toolCallCount });
    session?.appendMessage({
      type: 'session_end',
      status: 'completed',
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
  }

  if (session) {
    await disposeSession(session);
  }
}

async function handleAgentRunFailure(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  conversation: ConversationManager | null,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (conversation) {
    const lastMessages = conversation.getMessagesForLLM();
    const lastAssistant = [...lastMessages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
    }
  }
  record.status = 'failed';
  record.error = message;
  record.completedAt = Date.now();
  cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
  context.emitAgentFailedEvent(record.id, message, Date.now() - record.startedAt);
  context.emitOrchestrationFailed(record, message);
  logger.error(`Agent ${record.id} failed`, { error: message });
  if (session) {
    session.appendMessage({
      type: 'session_end',
      status: 'failed',
      error: message,
      toolCallCount: record.toolCallCount,
      durationMs: Date.now() - record.startedAt,
      timestamp: new Date().toISOString(),
    });
    await disposeSession(session);
  }
}

export async function runAgentTask(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
): Promise<void> {
  record.status = 'running';
  record.progress = 'Initialising…';
  record.usage = {
    inputTokens: record.usage?.inputTokens ?? 0,
    outputTokens: record.usage?.outputTokens ?? 0,
    cacheReadTokens: record.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: record.usage?.cacheWriteTokens ?? 0,
    ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
    llmCallCount: record.usage?.llmCallCount ?? 0,
    turnCount: record.usage?.turnCount ?? 0,
    reasoningSummaryCount: record.usage?.reasoningSummaryCount ?? 0,
  };
  context.emitAgentStarted(record.id);
  context.emitAgentProgress(record.id, record.progress);
  context.emitOrchestrationProgress(record, record.progress);

  let session: AgentSession | null = null;
  let conversation: ConversationManager | null = null;
  const preAgentProcessIds = new Set((context.processManager?.list() ?? []).map((p) => p.id));

  try {
    const providerRegistry = context.providerRegistry;
    const currentModel = providerRegistry.getCurrentModel();
    const primaryRoute = context.resolveProviderForRecord(providerRegistry, record, currentModel);
    let activeRoute = primaryRoute;
    let fallbackRouteIndex = 0;
    const fallbackRoutes = context.resolveFallbackModelRoutes(providerRegistry, record, primaryRoute.requestedModelId);
    const modelId = primaryRoute.modelId;

    session = new AgentSession(record.id, modelId, record.provider ?? currentModel.provider ?? 'unknown');
    session.appendMessage({ type: 'session_config', template: record.template, task: record.task, tools: record.tools, model: modelId, provider: record.provider ?? 'unknown', timestamp: new Date().toISOString() });

    const toolRegistry = context.buildScopedRegistry(record.tools, context.getFullRegistry());
    const toolDefinitions = toolRegistry.getToolDefinitions();
    const toolTokens = toolDefinitions.length > 0
      ? estimateTokens(JSON.stringify(toolDefinitions))
      : 0;

    conversation = new ConversationManager(() => 80);
    conversation.addUserMessage(record.task);

    let systemPrompt = buildOrchestratorSystemPrompt(record, undefined, context);

    let continueLoop = true;
    let turn = 0;
    record.progress = 'Turn 1 · Thinking…';
    context.emitAgentProgress(record.id, record.progress);
    context.emitOrchestrationProgress(record, record.progress);

    const callHistory: string[] = [];
    const LOOP_SYSTEM_THRESHOLD = 3;
    const LOOP_USER_THRESHOLD = 5;
    const CALL_HISTORY_WINDOW = 20;
    const circuitBreaker = new ConsecutiveErrorBreaker();

    while (continueLoop) {
      if ((record as { status: string }).status === 'cancelled') {
        record.completedAt = Date.now();
        context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
        cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
        if (session) {
          session.appendMessage({ type: 'session_end', status: 'cancelled', turn, timestamp: new Date().toISOString() });
          await disposeSession(session);
        }
        return;
      }
      if (++turn > MAX_TURNS) {
        const lastMessages = conversation.getMessagesForLLM();
        const lastAssistant = [...lastMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
        }
        record.status = 'failed';
        record.error = `Exceeded maximum turn limit (${MAX_TURNS})`;
        if (session) {
          session.appendMessage({ type: 'session_end', status: 'max_turns_exceeded', turn, timestamp: new Date().toISOString() });
          await disposeSession(session);
        }
        context.emitAgentFailedEvent(record.id, record.error, Date.now() - record.startedAt);
        return;
      }
      session.appendMessage({ type: 'llm_request', turn, messageCount: conversation.getMessagesForLLM().length, timestamp: new Date().toISOString() });
      const pending = context.messageBus.getMessages(record.id);
      for (const msg of pending) {
        const kindLabel = msg.kind[0]!.toUpperCase() + msg.kind.slice(1);
        conversation.addUserMessage(`[${kindLabel} from ${msg.from}]: ${msg.content}`);
      }

      if (context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true) {
        const modelDef = providerRegistry.listModels().find(
          (m) =>
            m.id === activeRoute.modelId ||
            m.registryKey === activeRoute.modelId ||
            m.id === activeRoute.requestedModelId ||
            m.registryKey === activeRoute.requestedModelId,
        ) ?? providerRegistry.getCurrentModel();
        const contextWindow = context.providerRegistry.getContextWindowForModel(modelDef);
        systemPrompt = applyContextWindowAwareness(
          context,
          record,
          activeRoute.modelId,
          contextWindow,
          conversation,
          systemPrompt,
          toolTokens,
          turn,
        );
      }

      let response: Awaited<ReturnType<LLMProvider['chat']>>;
      {
        let networkAttempt = 0;
        let rateLimitAttempt = 0;
        let contextRetried = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          let streamAccumulated = '';
          record.streamingContent = undefined;

          const onDelta = (delta: StreamDelta) => {
            if (delta.content) {
              streamAccumulated += delta.content;
              record.streamingContent = streamAccumulated;
              const snippet = streamAccumulated.length > 100
                ? '...' + streamAccumulated.slice(-97)
                : streamAccumulated;
              record.progress = snippet.replace(/\n/g, ' ').trim() || 'Streaming...';
            }
            context.emitStreamDelta(record.id, delta.content ?? '', streamAccumulated);
          };

          try {
            response = await activeRoute.provider.chat({
              model: activeRoute.modelId,
              messages: conversation.getMessagesForLLM(),
              tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
              systemPrompt,
              ...(record.reasoningEffort ? { reasoningEffort: record.reasoningEffort } : {}),
              onDelta,
            });
            break;
          } catch (chatErr) {
            if (
              isContextSizeExceededError(chatErr) &&
              !contextRetried &&
              (context.featureFlagManager?.isEnabled('agent-context-window-awareness') ?? true)
            ) {
              contextRetried = true;
              logger.warn(
                `[AgentOrchestrator] context-window awareness: context size exceeded on turn ${turn} - emergency compaction and retry`,
                { agentId: record.id, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Turn ${turn} · Context exceeded, compacting…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              const currentMessages = conversation.getMessagesForLLM();
              const compacted = compactSmallWindow(
                currentMessages,
                Math.max(5, Math.floor(currentMessages.length / 3)),
              );
              conversation.replaceMessagesForLLM(compacted);
              systemPrompt = buildLayeredOrchestratorSystemPrompt(record, 0, context);
            } else if (fallbackRouteIndex < fallbackRoutes.length) {
              const previousRoute = activeRoute;
              activeRoute = fallbackRoutes[fallbackRouteIndex++]!;
              const reason = chatErr instanceof Error ? chatErr.message : String(chatErr);
              logger.warn('[AgentOrchestrator] switching to fallback model', {
                agentId: record.id,
                from: previousRoute.requestedModelId,
                to: activeRoute.requestedModelId,
                reason,
              });
              context.providerOptimizer?.recordFallbackTransition(previousRoute.requestedModelId, activeRoute.requestedModelId, reason);
              record.progress = `Model fallback → ${activeRoute.requestedModelId}`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
            } else if (isNetworkError(chatErr) && networkAttempt < NETWORK_RETRY_DELAYS_MS.length) {
              const delayMs = NETWORK_RETRY_DELAYS_MS[networkAttempt]!;
              const delaySec = Math.round(delayMs / 1000);
              logger.warn(
                `Agent ${record.id}: network error on turn ${turn}, retrying in ${delaySec}s (attempt ${networkAttempt + 1}/${NETWORK_RETRY_DELAYS_MS.length})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Network error, retrying in ${delaySec}s…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              networkAttempt++;
              await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during network retry');
              }
            } else if (isRateLimitOrQuotaError(chatErr) && rateLimitAttempt < RATE_LIMIT_MAX_RETRIES) {
              const delaySec = Math.round(RATE_LIMIT_RETRY_DELAY_MS / 1000);
              logger.warn(
                `Agent ${record.id}: rate limited on turn ${turn}, retrying in ${delaySec}s (attempt ${rateLimitAttempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
                { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
              );
              record.progress = `Rate limited, retrying in ${delaySec}s…`;
              context.emitAgentProgress(record.id, record.progress);
              context.emitOrchestrationProgress(record, record.progress);
              rateLimitAttempt++;
              await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
              if ((record as { status: string }).status === 'cancelled') {
                throw new Error('Agent cancelled during rate limit retry');
              }
            } else {
              throw chatErr;
            }
          }
        }
        record.streamingContent = undefined;
        record.progress = `Turn ${turn} · Thinking…`;
      }

      session.appendMessage({ type: 'llm_response', turn, contentLength: response.content.length, toolCallCount: response.toolCalls.length, usage: response.usage, timestamp: new Date().toISOString() });
      record.usage = {
        inputTokens: (record.usage?.inputTokens ?? 0) + response.usage.inputTokens,
        outputTokens: (record.usage?.outputTokens ?? 0) + response.usage.outputTokens,
        cacheReadTokens: (record.usage?.cacheReadTokens ?? 0) + (response.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (record.usage?.cacheWriteTokens ?? 0) + (response.usage.cacheWriteTokens ?? 0),
        ...(record.usage?.reasoningTokens !== undefined ? { reasoningTokens: record.usage.reasoningTokens } : {}),
        llmCallCount: (record.usage?.llmCallCount ?? 0) + 1,
        turnCount: (record.usage?.turnCount ?? 0) + 1,
        reasoningSummaryCount: (record.usage?.reasoningSummaryCount ?? 0) + (response.reasoningSummary ? 1 : 0),
      };

      if (response.toolCalls.length > 0) {
        conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, usage: response.usage });
        const results = await executeToolCalls(
          response.toolCalls,
          toolRegistry,
          session,
          turn,
          record,
          callHistory,
          CALL_HISTORY_WINDOW,
          context,
        );
        conversation.addToolResults(results);

        const allFailed = results.length > 0 && results.every(r => r.success === false);
        if (allFailed) {
          const cbResult = circuitBreaker.recordAllFailed();
          logger.warn(`Agent ${record.id}: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
          if (cbResult === 'break') {
            conversation.addSystemMessage(
              `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. ` +
              `The agent loop is stopping to prevent an infinite failure cycle. ` +
              `Report what you were trying to do and what errors you encountered.`,
            );
            record.status = 'failed';
            record.error = `Circuit breaker tripped after ${circuitBreaker.consecutiveErrors} consecutive all-error turns`;
            record.completedAt = Date.now();
            continueLoop = false;
          } else if (cbResult === 'warn') {
            conversation.addSystemMessage(
              `You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
              `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
              `then try a completely different strategy.`,
            );
          }
        } else if (results.length > 0) {
          circuitBreaker.recordSuccess();
        }

        const sigCounts = new Map<string, { count: number; toolName: string }>();
        for (const sig of callHistory) {
          const name = sig.slice(0, sig.indexOf('::'));
          const entry = sigCounts.get(sig);
          if (entry) {
            entry.count++;
          } else {
            sigCounts.set(sig, { count: 1, toolName: name });
          }
        }
        let worstCount = 0;
        let worstTool = '';
        for (const [_sig, { count, toolName }] of sigCounts) {
          if (count > worstCount) {
            worstCount = count;
            worstTool = toolName;
          }
        }
        if (worstCount >= LOOP_USER_THRESHOLD) {
          logger.warn(`Agent ${record.id}: loop detected — ${worstTool} called ${worstCount} times with identical args`);
          conversation.addUserMessage(
            `You are repeating the same tool call. ${worstTool} has been called ${worstCount} times with identical arguments and results. Do NOT call ${worstTool} with these arguments again. Identify what you were trying to accomplish and take a different action.`,
          );
        } else if (worstCount >= LOOP_SYSTEM_THRESHOLD) {
          logger.warn(`Agent ${record.id}: possible loop — ${worstTool} called ${worstCount} times with identical args`);
          conversation.addSystemMessage(
            `You have already executed this exact call (${worstTool}) ${worstCount} times with identical arguments. The results from your previous calls are already in your conversation history. Review them and proceed to the next step.`,
          );
        }
        record.progress = `Turn ${turn} · Thinking…`;
      } else {
        conversation.addAssistantMessage(response.content, { usage: response.usage });
        record.fullOutput = response.content;
        record.progress = response.content.slice(0, 200) || 'Done.';
        continueLoop = false;
      }
    }

    await finalizeAgentRun(context, record, session, preAgentProcessIds);
  } catch (err) {
    await handleAgentRunFailure(context, record, conversation, session, preAgentProcessIds, err);
  }
}
