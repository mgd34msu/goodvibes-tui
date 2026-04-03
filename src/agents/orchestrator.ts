import { ConversationManager } from '../core/conversation.ts';
import { AgentMessageBus } from './message-bus.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { providerRegistry, getModelRegistry } from '../providers/registry.ts';
import { registerAllTools } from '../tools/index.ts';
import { logger } from '../utils/logger.ts';
import { ConsecutiveErrorBreaker } from '../core/circuit-breaker.ts';
import { isRateLimitOrQuotaError, isContextSizeExceededError } from '../types/errors.ts';
import { FileStateCache } from '../state/file-cache.ts';
import { ProjectIndex } from '../state/project-index.ts';
import { AgentSession } from './session.ts';
import { ArchetypeLoader } from './archetypes.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { LLMProvider, StreamDelta } from '../providers/interface.ts';
import type { EventBus } from '../core/event-bus.ts';
import { existsSync, readFileSync } from 'node:fs';
import { ProcessManager } from '../tools/shared/process-manager.ts';
import { join } from 'node:path';
import { getContextWindowForModel } from '../providers/model-limits.ts';
import {
  estimateTokens,
  estimateConversationTokens,
  compactSmallWindow,
} from '../core/context-compaction.ts';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.ts';

// ---------------------------------------------------------------------------
// Network error detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the error looks like a transient network failure that
 * may resolve on its own (dropped connection, DNS hiccup, etc.).
 * These are distinct from API-level errors (4xx / 5xx) which should not
 * be silently retried at this layer.
 */
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

/** Backoff delays (ms) for agent-level network retries — longer than the
 *  provider-level retries because we are waiting for the network to recover. */
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

/** Delay between rate-limit retries (ms). Each failed agent waits this long before retrying. */
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Context window awareness constants
// ---------------------------------------------------------------------------

/**
 * Fraction of context window at which pre-call compaction is triggered.
 * 0.85 = compact when estimated usage exceeds 85% of available window.
 */
const CONTEXT_COMPACT_THRESHOLD = 0.85;

/**
 * Minimum context window size (tokens) below which we skip LLM-based
 * compaction and only do rule-based truncation.
 * Matches SMALL_WINDOW_THRESHOLD from context-compaction.ts (12_000).
 */
const MIN_WINDOW_FOR_LLM_COMPACT = 12_000;



// ---------------------------------------------------------------------------
// Tool args summarizer
// ---------------------------------------------------------------------------

/**
 * Summarize tool call arguments into a brief display string for progress labels.
 * Extracts the most informative single string arg (path, cmd, etc.) and
 * truncates to 30 characters.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  // Extract the most informative single arg
  for (const key of ['path', 'file', 'cmd', 'pattern', 'url', 'query']) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  // Fallback: first string value found
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// AgentOrchestrator
// ---------------------------------------------------------------------------

/**
 * AgentOrchestrator — runs AgentRecord tasks in-process.
 *
 * Each agent gets its own ConversationManager and a scoped ToolRegistry
 * containing only the tools listed in record.tools. The execution loop
 * mirrors the main Orchestrator: send prompt → receive response → execute
 * tools → loop until no more tool calls.
 */
const MAX_TURNS = 50;

export class AgentOrchestrator {
  private static instance: AgentOrchestrator | null = null;
  private fullRegistry: ToolRegistry | null = null;
  private fileCache: FileStateCache | null = null;
  private projectIndex: ProjectIndex | null = null;
  private projectContextCache: string | null | undefined = undefined; // undefined = not cached, null = no context
  private eventBus: EventBus | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;

  /** Singleton accessor. */
  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  /** Reset the singleton — for testing only. */
  static resetInstance(): void {
    AgentOrchestrator.instance = null;
  }

  /** Set the EventBus for emitting agent lifecycle events (WRFC integration). */
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /** Set the FeatureFlagManager for G01 context-window awareness gating. */
  setFeatureFlagManager(manager: FeatureFlagManager): void {
    this.featureFlagManager = manager;
  }

  /**
   * Run an agent task described by the given record.
   * Updates record status, toolCallCount, progress, and error in-place.
   * Never throws — all errors are captured into record.error.
   */
  async runAgent(record: AgentRecord): Promise<void> {
    record.status = 'running';
    record.progress = 'Initialising…';

    let session: AgentSession | null = null;
    let conversation: ConversationManager | null = null;
    const preAgentProcessIds = new Set(ProcessManager.getInstance().list().map(p => p.id));

    try {
      // --- Resolve model and provider ---
      const requestedModelId = record.model;
      const currentModel = providerRegistry.getCurrentModel();
      let modelId = requestedModelId ?? currentModel.id;
      let provider: LLMProvider;
      try {
        provider = providerRegistry.getForModel(modelId, record.provider);
      } catch (err) {
        // If the LLM requested a specific model that doesn't exist, fall back to current model
        if (requestedModelId && requestedModelId !== currentModel.id) {
          logger.debug(`[AgentOrchestrator] Requested model '${requestedModelId}' not found, falling back to '${currentModel.id}'`);
          try {
            provider = providerRegistry.getForModel(currentModel.id);
            modelId = currentModel.id;
          } catch (fallbackErr) {
            throw new Error(
              `Cannot resolve provider for model '${requestedModelId}' (${
                err instanceof Error ? err.message : String(err)
              }) or fallback '${currentModel.id}' (${
                fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              })`,
            );
          }
        } else {
          throw new Error(
            `Cannot resolve provider for model '${modelId}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      session = new AgentSession(record.id, modelId, record.provider ?? currentModel.provider ?? 'unknown');
      session.appendMessage({ type: 'session_config', template: record.template, task: record.task, tools: record.tools, model: modelId, provider: record.provider ?? 'unknown', timestamp: new Date().toISOString() });

      // --- Build scoped tool registry ---
      const toolRegistry = this.buildScopedRegistry(record.tools, this.getFullRegistry());
      const toolDefinitions = toolRegistry.getToolDefinitions();

      // --- Tool token cost (computed once, used per-turn in G01 context check) ---
      const toolTokens = toolDefinitions.length > 0
        ? estimateTokens(JSON.stringify(toolDefinitions))
        : 0;

      // --- Conversation ---
      conversation = new ConversationManager(() => 80); // default terminal width for agent conversation
      conversation.addUserMessage(record.task);

      // --- System prompt ---
      // Declared as `let` so context-window awareness (G01) can rebuild with fewer layers.
      let systemPrompt = this.buildSystemPrompt(record);

      // --- Resolve model definition for context-window lookups (G01) ---
      const modelDef = getModelRegistry().find(
        (m) => m.id === modelId || m.registryKey === modelId,
      ) ?? providerRegistry.getCurrentModel();

      // --- Turn loop ---
      let continueLoop = true;
      let turn = 0;
      record.progress = 'Turn 1 · Thinking…';

      // --- Loop detection ---
      const callHistory: string[] = [];
      const LOOP_SYSTEM_THRESHOLD = 3;
      const LOOP_USER_THRESHOLD = 5;
      const CALL_HISTORY_WINDOW = 20;

      // --- Consecutive error circuit breaker ---
      const circuitBreaker = new ConsecutiveErrorBreaker();

      while (continueLoop) {
        if ((record as { status: string }).status === 'cancelled') {
          record.completedAt = Date.now();
          if (this.eventBus) {
            this.eventBus.emit('subagent:error', {
              id: record.id,
              error: new Error('Agent cancelled'),
            });
          }
          // Kill any background processes leaked by this agent
          const pm = ProcessManager.getInstance();
          for (const p of pm.list()) {
            if (!preAgentProcessIds.has(p.id)) pm.stop(p.id);
          }
          if (session) {
            session.appendMessage({ type: 'session_end', status: 'cancelled', turn, timestamp: new Date().toISOString() });
            try { await session.dispose(); } catch { /* non-fatal */ }
          }
          return;
        }
        if (++turn > MAX_TURNS) {
          // Capture last assistant response before failing
          const lastMessages = conversation.getMessagesForLLM();
          const lastAssistant = [...lastMessages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
          }
          record.status = 'failed';
          record.error = `Exceeded maximum turn limit (${MAX_TURNS})`;
          if (session) {
            session.appendMessage({ type: 'session_end', status: 'max_turns_exceeded', turn, timestamp: new Date().toISOString() });
            try { await session.dispose(); } catch { /* non-fatal */ }
          }
          return;
        }
        session.appendMessage({ type: 'llm_request', turn, messageCount: conversation.getMessagesForLLM().length, timestamp: new Date().toISOString() });
        // Retrieve any pending messages for this agent and inject them as user messages
        const bus = AgentMessageBus.getInstance();
        const pending = bus.getMessages(record.id);
        for (const msg of pending) {
          // Inject as user message so LLM responds to inter-agent communication
          conversation.addUserMessage(`[Message from agent ${msg.from}]: ${msg.content}`);
        }
        // --- G01: Context-window pre-check ---
        // Before calling provider.chat(), estimate total token usage and compact
        // messages or trim the system prompt when approaching the context limit.
        if (this.featureFlagManager?.isEnabled('g01-agent-context-window-awareness') ?? true) {
          const contextWindow = getContextWindowForModel(modelDef);
          if (contextWindow === 0) {
            logger.debug(`[G01] Context window is 0/unknown for model ${modelId}, skipping context validation`);
          } else {
            const messages = conversation.getMessagesForLLM();
            const msgTokens = estimateConversationTokens(messages);
            const sysTokens = estimateTokens(systemPrompt);
            const totalEstimate = msgTokens + sysTokens + toolTokens;
            const threshold = Math.floor(contextWindow * CONTEXT_COMPACT_THRESHOLD);

            if (totalEstimate > threshold) {
              logger.warn(
                `[AgentOrchestrator] G01: estimated ${totalEstimate} tokens exceeds ${threshold} (${Math.round(CONTEXT_COMPACT_THRESHOLD * 100)}% of ${contextWindow}) — compacting`,
                { agentId: record.id, turn, msgTokens, sysTokens, toolTokens, contextWindow },
              );
              record.progress = `Turn ${turn} · Compacting context…`;

              if (contextWindow <= MIN_WINDOW_FOR_LLM_COMPACT) {
                // Small window: rule-based truncation only
                const compacted = compactSmallWindow(messages);
                conversation.replaceMessagesForLLM(compacted);
              } else {
                // Standard window: rule-based message compaction (keep recent 50%).
                // Full LLM-based summarisation would produce higher-quality compaction
                // but requires an async provider call with full context — that's a
                // follow-up improvement. For now, simple truncation keeps the tail of
                // the conversation where the most relevant work lives.
                const compacted = compactSmallWindow(messages, Math.max(10, Math.floor(messages.length / 2)));
                conversation.replaceMessagesForLLM(compacted);
              }

              // After message compaction, check if system prompt still fits.
              // Apply layered trimming: drop conventions first, then project context.
              const remainingAfterMsgs = contextWindow - estimateConversationTokens(conversation.getMessagesForLLM()) - toolTokens;
              const currentSysTokens = estimateTokens(systemPrompt);
              if (currentSysTokens > remainingAfterMsgs * CONTEXT_COMPACT_THRESHOLD) {
                logger.warn(
                  `[AgentOrchestrator] G01: system prompt (${currentSysTokens} tokens) too large for remaining window (${remainingAfterMsgs}) — applying layered trim`,
                  { agentId: record.id },
                );
                systemPrompt = this.buildLayeredSystemPrompt(record, remainingAfterMsgs);
              }
            }
          }
        }

        // --- Network-aware retry around the LLM call ---
        // provider.chat() already has short provider-level retries (~30s total).
        // This outer loop waits for the network to come back (up to ~2.5 min
        // of additional wait) before giving up and failing the agent.
        let response: Awaited<ReturnType<typeof provider.chat>>;
        {
          let networkAttempt = 0;
          let rateLimitAttempt = 0;
          let contextRetried = false;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            // Reset streaming state for this retry attempt
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
              if (this.eventBus && delta.content) {
                try {
                  this.eventBus.emit('subagent:stream-delta', {
                    id: record.id,
                    content: delta.content,
                    accumulated: streamAccumulated,
                  });
                } catch {
                  // Don't let listener errors kill streaming
                }
              }
            };

            try {
              response = await provider.chat({
                model: modelId,
                messages: conversation.getMessagesForLLM(),
                tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
                systemPrompt,
                onDelta,
              });
              break; // success — exit retry loop
            } catch (chatErr) {
              if (isNetworkError(chatErr) && networkAttempt < NETWORK_RETRY_DELAYS_MS.length) {
                const delayMs = NETWORK_RETRY_DELAYS_MS[networkAttempt]!;
                const delaySec = Math.round(delayMs / 1000);
                logger.warn(
                  `Agent ${record.id}: network error on turn ${turn}, retrying in ${delaySec}s (attempt ${networkAttempt + 1}/${NETWORK_RETRY_DELAYS_MS.length})`,
                  { error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
                );
                record.progress = `Network error, retrying in ${delaySec}s…`;
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
                rateLimitAttempt++;
                await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
                if ((record as { status: string }).status === 'cancelled') {
                  throw new Error('Agent cancelled during rate limit retry');
                }
              } else if (
                isContextSizeExceededError(chatErr) &&
                !contextRetried &&
                (this.featureFlagManager?.isEnabled('g01-agent-context-window-awareness') ?? true)
              ) {
                // G01: context size exceeded — compact messages and retry once
                contextRetried = true;
                logger.warn(
                  `[AgentOrchestrator] G01: context size exceeded on turn ${turn} — emergency compaction and retry`,
                  { agentId: record.id, error: chatErr instanceof Error ? chatErr.message : String(chatErr) },
                );
                record.progress = `Turn ${turn} · Context exceeded, compacting…`;
                const currentMessages = conversation.getMessagesForLLM();
                const compacted = compactSmallWindow(
                  currentMessages,
                  Math.max(5, Math.floor(currentMessages.length / 3)),
                );
                conversation.replaceMessagesForLLM(compacted);
                // Also strip system prompt to bare minimum
                systemPrompt = this.buildLayeredSystemPrompt(record, 0);
              } else {
                // Not a network/rate-limit/context error, or all retries exhausted — re-throw
                // to let the outer catch handle it and fail the agent.
                throw chatErr;
              }
            }
          }
          record.streamingContent = undefined;
          record.progress = `Turn ${turn} · Thinking…`;
        }

        session.appendMessage({ type: 'llm_response', turn, contentLength: response.content.length, toolCallCount: response.toolCalls.length, usage: response.usage, timestamp: new Date().toISOString() });

        if (response.toolCalls.length > 0) {
          conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, usage: response.usage });

          // Execute tools sequentially
          const results = [];
          for (const originalCall of response.toolCalls) {
            // Create mutable copy — some providers (e.g. ollama-cloud/kimi) freeze response objects
            const call = { ...originalCall, arguments: { ...originalCall.arguments } };
            // Build a brief args summary for the progress label
            const argsSummary = summarizeToolArgs(call.arguments as Record<string, unknown>);
            record.progress = `Turn ${turn} · ${call.name}${argsSummary}`;
            record.toolCallCount++;
            if (this.eventBus) {
              try {
                this.eventBus.emit('subagent:progress', { id: record.id, progress: record.progress });
              } catch (e) { logger.debug('subagent:progress emit failed', { error: String(e) }); }
            }

            // Sanitize exec args for agent context: force inline execution, 10-min TTL
            if (call.name === 'exec' || call.name === 'precision_exec') {
              // Deep clone for nested mutation safety
              call.arguments = structuredClone(call.arguments);
              const execArgs = call.arguments as Record<string, unknown>;
              // Force all commands to run inline (no background leaks)
              if (Array.isArray(execArgs.commands)) {
                for (const cmd of execArgs.commands as Record<string, unknown>[]) {
                  cmd.background = false;
                  if (!cmd.timeout_ms) cmd.timeout_ms = 600_000; // 10 min default
                }
              }
              // Set global timeout default
              if (!execArgs.timeout_ms) execArgs.timeout_ms = 600_000;
            }

            const callSig = `${call.name}::${JSON.stringify(call.arguments)}`;
            try {
              const result = await toolRegistry.execute(call.id, call.name, call.arguments);
              results.push(result);
              session.appendMessage({ type: 'tool_execution', turn, toolName: call.name, toolCallId: call.id, success: result.success !== false, args: JSON.stringify(call.arguments).slice(0, 500), resultPreview: (result.output ?? result.error ?? '').slice(0, 500), timestamp: new Date().toISOString() });
            } catch (err) {
              const toolErr = err instanceof Error ? err.message : String(err);
              results.push({
                callId: call.id,
                success: false,
                error: toolErr,
              });
              session.appendMessage({ type: 'tool_execution', turn, toolName: call.name, toolCallId: call.id, success: false, args: JSON.stringify(call.arguments).slice(0, 500), resultPreview: toolErr.slice(0, 500), timestamp: new Date().toISOString() });
            }
            callHistory.push(callSig);
            if (callHistory.length > CALL_HISTORY_WINDOW) callHistory.shift();
          }

          conversation.addToolResults(results);

          // --- Consecutive error circuit breaker ---
          const allFailed = results.length > 0 && results.every(r => r.success === false);
          if (allFailed) {
            const cbResult = circuitBreaker.recordAllFailed();
            logger.warn(`Agent ${record.id}: consecutive all-error turn ${circuitBreaker.consecutiveErrors}`);
            if (cbResult === 'break') {
              // Use addSystemMessage for consistency with core orchestrator
              // (system messages are preferable to user messages for internal control signals)
              conversation.addSystemMessage(
                `CIRCUIT BREAKER: You have made ${circuitBreaker.consecutiveErrors} consecutive turns where ALL tool calls failed. ` +
                `The agent loop is stopping to prevent an infinite failure cycle. ` +
                `Report what you were trying to do and what errors you encountered.`
              );
              record.status = 'failed';
              record.error = `Circuit breaker tripped after ${circuitBreaker.consecutiveErrors} consecutive all-error turns`;
              record.completedAt = Date.now();
              continueLoop = false;
            } else if (cbResult === 'warn') {
              conversation.addSystemMessage(
                `You have made ${circuitBreaker.consecutiveErrors} consecutive tool calls that ALL failed. ` +
                `Stop attempting the same approach. Describe what you're trying to do and what's going wrong, ` +
                `then try a completely different strategy.`
              );
            }
          } else if (results.length > 0) {
            // At least one success — reset the counter
            circuitBreaker.recordSuccess();
          }

          // --- Loop detection: nudge if any signature repeats ---
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
          // Find worst offender
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
          // Final response — no more tool calls
          conversation.addAssistantMessage(response.content, { usage: response.usage });
          record.fullOutput = response.content;
          record.progress = response.content.slice(0, 200) || 'Done.';
          continueLoop = false;
        }
      }

      // Don't overwrite 'failed' status set by circuit breaker or other in-loop failures
      if (record.status !== 'failed') {
        record.status = 'completed';
      }
      record.completedAt = Date.now();
      // Kill any background processes leaked by this agent
      const pm = ProcessManager.getInstance();
      for (const p of pm.list()) {
        if (!preAgentProcessIds.has(p.id)) {
          pm.stop(p.id);
        }
      }
      // Emit completion event for WrfcController (only if truly completed, not circuit-broken)
      if (this.eventBus && record.status !== 'failed') {
        this.eventBus.emit('subagent:complete', {
          id: record.id,
          result: {
            id: record.id,
            success: true,
            output: record.fullOutput ?? '',
            toolCallsMade: record.toolCallCount,
            duration: (record.completedAt ?? Date.now()) - record.startedAt,
          },
        });
      }
      if (record.status === 'failed') {
        // Circuit breaker tripped — emit error event and log
        if (this.eventBus) {
          this.eventBus.emit('subagent:error', {
            id: record.id,
            error: new Error(record.error ?? 'Circuit breaker tripped'),
          });
        }
        logger.error(`Agent ${record.id} circuit-breaker terminated`, { error: record.error, toolCallCount: record.toolCallCount });
        session.appendMessage({ type: 'session_end', status: 'failed', error: record.error, toolCallCount: record.toolCallCount, durationMs: Date.now() - record.startedAt, timestamp: new Date().toISOString() });
      } else {
        logger.info(`Agent ${record.id} completed`, { toolCallCount: record.toolCallCount });
        session.appendMessage({ type: 'session_end', status: 'completed', toolCallCount: record.toolCallCount, durationMs: Date.now() - record.startedAt, timestamp: new Date().toISOString() });
      }
      try { await session.dispose(); } catch { /* non-fatal */ }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Capture last assistant response before failing
      if (conversation) {
        const lastMessages = conversation.getMessagesForLLM();
        const lastAssistant = [...lastMessages].reverse().find(m => m.role === 'assistant');
        if (lastAssistant) {
          record.fullOutput = typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
        }
      }
      record.status = 'failed';
      record.error = message;
      record.completedAt = Date.now();
      // Kill any background processes leaked by this agent
      const pm = ProcessManager.getInstance();
      for (const p of pm.list()) {
        if (!preAgentProcessIds.has(p.id)) {
          pm.stop(p.id);
        }
      }
      // Emit error event for WrfcController
      if (this.eventBus) {
        this.eventBus.emit('subagent:error', {
          id: record.id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
      logger.error(`Agent ${record.id} failed`, { error: message });
      if (session) {
        session.appendMessage({ type: 'session_end', status: 'failed', error: message, toolCallCount: record.toolCallCount, durationMs: Date.now() - record.startedAt, timestamp: new Date().toISOString() });
        try { await session.dispose(); } catch { /* non-fatal */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** 
   * Inject shared file-cache and project-index so agent tools share state with main session.
   * Call once during application startup, before any agents are spawned.
   */
  setDependencies(fileCache: FileStateCache, projectIndex: ProjectIndex): void {
    this.fileCache = fileCache;
    this.projectIndex = projectIndex;
    this.fullRegistry = null; // invalidate cached registry so it rebuilds with new deps
  }

  /** Lazily build and cache the full ToolRegistry. */
  private getFullRegistry(): ToolRegistry {
    if (!this.fullRegistry) {
      this.fullRegistry = new ToolRegistry();
      if ((this.fileCache == null) !== (this.projectIndex == null)) {
        logger.warn('AgentOrchestrator: partial deps — both fileCache and projectIndex should be set together');
      }
      const deps = this.fileCache && this.projectIndex
        ? { fileCache: this.fileCache, projectIndex: this.projectIndex }
        : undefined;
      registerAllTools(this.fullRegistry, deps);
    }
    return this.fullRegistry;
  }

  /**
   * Build a ToolRegistry containing only the tools whose names appear in
   * the allowedNames list. Filters the provided full registry into a fresh
   * scoped registry.
   */
  private buildScopedRegistry(allowedNames: string[], fullRegistry: ToolRegistry): ToolRegistry {
    // Filter to only the allowed tools (excluding 'agent' to prevent recursion)
    const allowed = new Set(allowedNames.filter((n) => n !== 'agent'));

    const scopedRegistry = new ToolRegistry();
    for (const tool of fullRegistry.list()) {
      if (allowed.has(tool.definition.name)) {
        scopedRegistry.register(tool);
      }
    }

    return scopedRegistry;
  }

  /** Build a layered system prompt: base + archetype + project context + conventions.
   * Layers 3 (project context) and 4 (conventions) are omitted when their key appears in skipLayers.
   */
  private buildSystemPrompt(record: AgentRecord, skipLayers?: Set<string>): string {
    const parts: string[] = [];

    // --- Layer 1: Base instructions ---
    // Build tool descriptions for only the tools this agent has
    const toolDescriptions: Record<string, string> = {
      read: 'read files (supports extract modes: content, outline, symbols, lines)',
      write: 'create new files (auto-creates parent directories)',
      edit: 'find-and-replace in existing files (supports exact, fuzzy, regex matching)',
      find: 'search files by glob pattern, content regex, or symbol extraction',
      exec: 'run shell commands (build, test, lint, install)',
      analyze: 'code analysis (impact, dependencies, dead code, security, coverage)',
      inspect: 'project structure, API routes, database schema, components',
      state: 'read/write session state and persistent memory',
      fetch: 'HTTP requests with extraction modes (json, markdown, text, code blocks)',
      workflow: 'manage workflow state machines, triggers, and scheduled tasks',
      registry: 'discover and inspect available skills, agents, and tools',
    };

    const toolLines = record.tools
      .filter(t => t !== 'agent')
      .map(t => toolDescriptions[t] ? `- ${t} — ${toolDescriptions[t]}` : `- ${t}`)
      .join('\n');

    const toolNames = record.tools.filter(t => t !== 'agent').join(', ');
    parts.push(`You are an autonomous agent in goodvibes-tui. Complete your task fully. No human is monitoring you — never ask questions, never wait for guidance. If something is ambiguous, make the best choice and continue.

## Tools
You have access to: ${toolNames}
${toolLines}

If MCP tools are available (e.g., context7 for library documentation), use them for research before guessing at API usage.

## Rules
1. Understand before editing. Never modify a file without first reading or searching its content to know what you're changing.
2. Write-local, read-global. Only create/modify files within the working directory. Read anything for context.
3. Validate after changes. Run typecheck/lint/test when the project supports them.
4. No mocks, no placeholders. Every implementation must be production-ready with proper error handling and types.
5. No narration. Don't explain your process or repeat the task.

## Recovery
When something fails or you need to learn how a library/framework works:
1. Try with your own knowledge
2. Search for documentation via the context7 MCP tool (resolve-library-id then query-docs) if available
3. Read relevant source files, configs, or local docs for context
4. Try an alternative approach
If repeated attempts fail, report the failure clearly and move on. Do not loop indefinitely.

## Logging
Use the state tool (mode: memory) to record decisions and failures to .goodvibes/memory/ when you make significant choices or encounter errors worth preventing in future runs.

## Output
When complete, report only:
- Summary: 1-2 sentences
- Changes: files created/modified
- Decisions: choices made + rationale
- Issues: problems encountered
- Uncertainties: anything the caller should verify

## Structured Output
You MUST end your final message with a JSON completion report inside a \`\`\`json block.
The report format depends on your role:

**Engineer:**
\`\`\`json
{
  "version": 1,
  "archetype": "engineer",
  "wrfcId": "<wrfc-id from context, or null>",
  "summary": "1-2 sentence summary",
  "filesCreated": ["path/to/new/file.ts"],
  "filesModified": ["path/to/changed/file.ts"],
  "filesDeleted": [],
  "decisions": [{"what": "chose X", "why": "because Y"}],
  "issues": ["issue description"],
  "uncertainties": ["thing to verify"]
}
\`\`\`

**Reviewer:**
\`\`\`json
{
  "version": 1,
  "archetype": "reviewer",
  "wrfcId": "<wrfc-id>",
  "summary": "review summary",
  "score": 9.5,
  "passed": true,
  "dimensions": [{"name": "Correctness", "score": 1.0, "maxScore": 1.0, "issues": []}],
  "issues": [{"severity": "minor", "description": "...", "file": "...", "line": 10, "pointValue": 0.1}]
}
\`\`\`

**Tester:**
\`\`\`json
{
  "version": 1,
  "archetype": "tester",
  "wrfcId": "<wrfc-id>",
  "summary": "testing summary",
  "testsWritten": ["test/file.test.ts"],
  "testsPassed": 10,
  "testsFailed": 0,
  "coverage": {"lines": 95, "branches": 88, "functions": 92},
  "failures": []
}
\`\`\`

**Other archetypes:**
\`\`\`json
{
  "version": 1,
  "archetype": "<your-archetype>",
  "wrfcId": "<wrfc-id>",
  "summary": "what was accomplished",
  "result": "detailed result"
}
\`\`\``);

    // --- Layer 2: Archetype overlay ---
    const archetype = ArchetypeLoader.getInstance().loadArchetype(record.template);
    if (archetype?.systemPrompt) {
      parts.push(archetype.systemPrompt);
    } else {
      // Fallback: minimal role description from built-in templates
      const roleDescriptions: Record<string, string> = {
        engineer: '## Role: Engineer\nFull-stack implementation agent. Build production-ready features with error handling, type safety, input validation, and security. Follow existing project patterns.\n\nYour final message MUST include a structured EngineerReport JSON block (see Structured Output section).\n\nWill NOT do: architecture planning, code review, test writing, deployment.',
        reviewer: '## Role: Reviewer\nCode review and quality assessment agent. Evaluate code for correctness, security, performance, and adherence to project conventions. Produce structured pass/fail assessments with specific issues.\n\nYour final message MUST include a structured ReviewerReport JSON block (see Structured Output section).\n\nWill NOT do: implementation, deployment, testing.',
        tester: '## Role: Tester\nTest writing and execution agent. Write comprehensive tests, run test suites, and report coverage. Ensure edge cases are covered.\n\nYour final message MUST include a structured TesterReport JSON block (see Structured Output section).\n\nWill NOT do: implementation, architecture, deployment.',
        researcher: '## Role: Researcher\nCodebase exploration and analysis agent. Investigate code structure, trace data flows, find patterns, and report findings. Answer questions about how the code works.\n\nWill NOT do: implementation, testing, deployment.',
        general: '## Role: General\nGeneral-purpose agent. Complete the assigned task using the tools available.',
      };
      const roleDesc = roleDescriptions[record.template] ?? roleDescriptions.general;
      parts.push(roleDesc);
    }

    // --- Layer 3: Project context ---
    if (!skipLayers?.has('project')) {
      const projectContext = this.buildProjectContext();
      if (projectContext) {
        parts.push(projectContext);
      }
    }

    // --- Layer 4: Conventions ---
    if (!skipLayers?.has('conventions')) {
      const conventions = this.loadConventions();
      if (conventions) {
        parts.push(conventions);
      }
    }

    // --- Layer 5: Task ---
    parts.push(`## Task\n${record.task}`);

    return parts.join('\n\n');
  }

  /**
   * Build a system prompt with progressively fewer layers based on token budget.
   * Layer order (dropped last to first when space is tight):
   *   Layer 5: Task (always included)
   *   Layer 1: Base instructions (always included)
   *   Layer 2: Archetype overlay (always included)
   *   Layer 3: Project context (dropped first when tight)
   *   Layer 4: Conventions (dropped first when tightest)
   *
   * When remainingTokens is 0, returns the minimal prompt (layers 1+2+5 only).
   */
  private buildLayeredSystemPrompt(record: AgentRecord, remainingTokens: number): string {
    // Always include base instructions + archetype + task
    const base = this.buildSystemPrompt(record);
    if (remainingTokens === 0) {
      // Emergency: strip to task-only minimal prompt
      logger.warn('[AgentOrchestrator] G01: emergency system prompt — base layers only', { agentId: record.id });
      const parts: string[] = [];
      const toolNames = record.tools.filter(t => t !== 'agent').join(', ');
      parts.push(`You are an autonomous agent. Complete your task. Tools: ${toolNames}.`);
      parts.push(`## Task\n${record.task}`);
      return parts.join('\n\n');
    }
    const baseTokens = estimateTokens(base);
    if (baseTokens <= remainingTokens) {
      return base; // Full prompt fits — return as-is
    }

    // Try without conventions
    const noConventions = this.buildSystemPrompt(record, new Set(['conventions']));
    const noConvTokens = estimateTokens(noConventions);
    if (noConvTokens <= remainingTokens) {
      logger.info('[AgentOrchestrator] G01: system prompt trimmed — dropped conventions layer', { agentId: record.id });
      return noConventions;
    }

    // Try without conventions AND project context
    const noContext = this.buildSystemPrompt(record, new Set(['conventions', 'project']));
    const noContextTokens = estimateTokens(noContext);
    if (noContextTokens <= remainingTokens) {
      logger.info('[AgentOrchestrator] G01: system prompt trimmed — dropped conventions + project context', { agentId: record.id });
      return noContext;
    }

    // Final fallback: truncate the reduced prompt to fit
    const targetChars = remainingTokens * 4; // rough chars from tokens
    const truncated = noContext.length > targetChars
      ? noContext.slice(0, targetChars) + '\n[...system prompt truncated to fit context window]'
      : noContext;
    logger.warn('[AgentOrchestrator] G01: system prompt hard-truncated to fit context window', { agentId: record.id, chars: truncated.length });
    return truncated;
  }


  /** Build project context from package.json and filesystem markers. */
  private buildProjectContext(): string | null {
    if (this.projectContextCache !== undefined) return this.projectContextCache;
    try {
      const cwd = process.cwd();
      const lines: string[] = ['## Project', `- Directory: ${cwd}`];

      // Detect project type and package manager
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name) lines.push(`- Name: ${pkg.name}`);

          // Package manager
          if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) lines.push('- Package manager: bun');
          else if (existsSync(join(cwd, 'yarn.lock'))) lines.push('- Package manager: yarn');
          else if (existsSync(join(cwd, 'pnpm-lock.yaml'))) lines.push('- Package manager: pnpm');
          else lines.push('- Package manager: npm');

          // TypeScript
          lines.push(`- TypeScript: ${existsSync(join(cwd, 'tsconfig.json')) ? 'yes' : 'no'}`);

          // Test framework
          const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
          if (allDeps['vitest']) lines.push('- Test framework: vitest');
          else if (allDeps['jest']) lines.push('- Test framework: jest');
          else if (pkg.scripts?.test === 'bun test' || pkg.scripts?.test?.startsWith('bun test ')) lines.push('- Test framework: bun:test');

          // Scripts
          const scriptNames = Object.keys(pkg.scripts ?? {}).slice(0, 10);
          if (scriptNames.length > 0) {
            lines.push(`- Available scripts: ${scriptNames.join(', ')}`);
          }
        } catch {
          lines.push('- Type: nodejs (package.json unreadable)');
        }
      } else if (existsSync(join(cwd, 'Cargo.toml'))) {
        lines.push('- Type: rust');
      } else if (existsSync(join(cwd, 'go.mod'))) {
        lines.push('- Type: go');
      } else if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'requirements.txt'))) {
        lines.push('- Type: python');
      }

      // Entry points
      const entryPoints: string[] = [];
      for (const ep of ['src/index.ts', 'src/main.ts', 'src/index.js', 'index.ts', 'index.js']) {
        if (existsSync(join(cwd, ep))) entryPoints.push(ep);
      }
      if (entryPoints.length > 0) {
        lines.push(`- Entry points: ${entryPoints.join(', ')}`);
      }

      this.projectContextCache = lines.join('\n');
      return this.projectContextCache;
    } catch {
      this.projectContextCache = null;
      return null;
    }
  }

  /** Load project conventions from .goodvibes/GOODVIBES.md, truncated to ~200 tokens. */
  private loadConventions(): string | null {
    try {
      const candidates = [
        join(process.cwd(), '.goodvibes', 'GOODVIBES.md'),
        join(process.cwd(), 'GOODVIBES.md'),
      ];
      for (const path of candidates) {
        if (existsSync(path)) {
          const content = readFileSync(path, 'utf-8');
          // Truncate to ~800 chars
          const truncated = content.length > 800
            ? content.slice(0, 800) + '\n[...truncated]'
            : content;
          return `## Conventions\n${truncated}`;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** Module-level singleton — import and use everywhere. */
export const agentOrchestrator = AgentOrchestrator.getInstance();
