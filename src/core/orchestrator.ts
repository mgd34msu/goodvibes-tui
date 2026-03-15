import type { ConversationManager } from './conversation.ts';
import type { EventBus } from './event-bus.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import { PermissionError, ProviderError, ToolError } from '../types/errors.ts';
import { formatProviderError } from '../utils/error-display.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { LLMProvider, StreamDelta, ContentPart } from '../providers/interface.ts';
import { config, configManager } from '../config/index.ts';
import { notifyCompletion } from '../utils/notify.ts';
import type { PermissionManager } from '../permissions/manager.ts';
import type { AcpManager } from '../acp/manager.ts';
import type { SubagentTask } from '../acp/protocol.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Orchestrator - Manages LLM turn lifecycle with full tool-use loop.
 * Supports multi-turn agent loops: call LLM -> execute tools -> send results -> repeat.
 */
export class Orchestrator {
  public isThinking = false;
  public thinkingFrame = 0;
  public usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  public messageQueue: { text: string; content?: ContentPart[] }[] = [];

  private animInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private acpManager: AcpManager | null = null;
  /** Message count at the start of a turn, used to rollback on cancel. */
  private turnStartMessageCount = 0;
  /** Whether a streaming block is currently active (for cleanup on abort). */
  private isStreaming = false;
  /** Last token warning bracket (multiples of 10%) to avoid repeat warnings at same level. */
  private lastWarningBracket = 0;

  constructor(
    private bus: EventBus,
    private conversation: ConversationManager,
    private getViewportHeight: () => number,
    private scrollToEnd: (vHeight: number) => void,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
    private getSystemPrompt: () => string = () => '',
  ) {}

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
    return SPINNER_FRAMES[this.thinkingFrame % SPINNER_FRAMES.length];
  }

  /** Abort the current in-flight LLM request, if any. */
  public abort(): void {
    this.abortController?.abort();
  }

  /**
   * handleUserInput - Entry point for a user-submitted message.
   * Queues if already thinking, otherwise kicks off the LLM turn.
   * @param text - Plain text representation (for display and queuing).
   * @param content - Optional ContentPart[] for multimodal messages.
   */
  public async handleUserInput(text: string, content?: ContentPart[]): Promise<void> {
    if (!text.trim() && !content?.length) return;

    if (this.isThinking) {
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
    this.scrollToEnd(this.getViewportHeight());
    this.bus.emit('render:request');
  }

  private async runTurn(text: string, content?: ContentPart[]): Promise<void> {
    const turnStartTime = Date.now();
    this.bus.emit('turn:start', { prompt: text });

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
    this.startThinking();

    try {
      const model = providerRegistry.getCurrentModel();
      const provider: LLMProvider = providerRegistry.getForModel(model.id);
      const toolDefinitions = this.toolRegistry.getToolDefinitions();
      const streamEnabled = configManager.get('display.stream') as boolean;

      let continueLoop = true;
      while (continueLoop) {
        // Wire up streaming delta handler when streaming is enabled
        let streamAccumulated = '';
        let reasoningAccumulated = '';
        const onDelta = streamEnabled
          ? (delta: StreamDelta) => {
              if (delta.content) {
                streamAccumulated += delta.content;
                this.conversation.updateStreamingBlock(streamAccumulated);
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

        const response = await provider.chat({
          model: model.id,
          messages: this.conversation.getMessagesForLLM(),
          tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
          systemPrompt: this.getSystemPrompt(),
          reasoningEffort: (() => {
            const configured = configManager.get('provider.reasoningEffort') as string | undefined;
            if (configured) return configured as 'instant' | 'low' | 'medium' | 'high';
            return model.capabilities.reasoning ? 'medium' : undefined;
          })(),
          signal: this.abortController?.signal,
          onDelta,
        });

        if (onDelta) {
          this.isStreaming = false;
          this.conversation.finalizeStreamingBlock();
          this.bus.emit('turn:stream-end');
        }

        this.usage.input += response.usage.inputTokens;
        this.usage.output += response.usage.outputTokens;
        this.usage.cacheRead += response.usage.cacheReadTokens ?? 0;
        this.usage.cacheWrite += response.usage.cacheWriteTokens ?? 0;

        this.bus.emit('turn:llm-response', {
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // Gather reasoning/thinking content from stream or response
        const reasoningForMsg = reasoningAccumulated || undefined;
        const reasoningSummaryForMsg = response.reasoningSummary || undefined;

        if (response.toolCalls.length > 0) {
          // Add assistant turn (may include both content and tool calls)
          this.conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, reasoningContent: reasoningForMsg, reasoningSummary: reasoningSummaryForMsg, usage: response.usage });

          // Execute tools and collect results
          const results = await this.executeToolCalls(response.toolCalls);

          // Add tool results — LLM sees them on next iteration
          this.conversation.addToolResults(results);

          // Loop continues: send results back to LLM
        } else {
          // No tool calls — final response
          this.conversation.addAssistantMessage(response.content, { reasoningContent: reasoningForMsg, reasoningSummary: reasoningSummaryForMsg, usage: response.usage });
          this.bus.emit('turn:complete', { response: response.content });
          continueLoop = false;
        }
      }

      // Token budget warning: check context usage after turn completes
      const totalTokens = this.conversation.estimateTotalTokens();
      const currentModel = providerRegistry.getCurrentModel();
      const maxTokens = currentModel.contextWindow;
      if (maxTokens > 0) {
        const usagePct = Math.round((totalTokens / maxTokens) * 100);
        const threshold = configManager.get('behavior.autoCompactThreshold') as number;
        const bracket = Math.floor(usagePct / 10) * 10;
        if (usagePct >= threshold && bracket > this.lastWarningBracket) {
          this.lastWarningBracket = bracket;
          this.conversation.addSystemMessage(
            `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Consider running /compact to free space.`
          );
          this.bus.emit('context:warning', { usage: usagePct, threshold });
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
      this.bus.emit('turn:error', { error });
    } finally {
      this.stopThinking();
      const durationMs = Date.now() - turnStartTime;
      const notifyEnabled = configManager.get('behavior.notifyOnComplete') as boolean | undefined;
      if (notifyEnabled !== false) {
        notifyCompletion('GoodVibes', `Response complete (${Math.round(durationMs / 1000)}s)`, durationMs);
      }
    }
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
      }

      this.bus.emit('turn:tool-result', { callId: call.id, result });
      results.push(result);
    }

    return results;
  }
}
