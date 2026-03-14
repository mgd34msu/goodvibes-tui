import type { ConversationManager } from './conversation.ts';
import type { EventBus } from './event-bus.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';
import { PermissionError, ProviderError, ToolError } from '../types/errors.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { LLMProvider } from '../providers/interface.ts';
import { config } from '../config.ts';
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
  public usage = { up: 0, down: 0 };
  public messageQueue: string[] = [];

  private animInterval: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private acpManager: AcpManager | null = null;
  /** Message count at the start of a turn, used to rollback on cancel. */
  private turnStartMessageCount = 0;

  constructor(
    private bus: EventBus,
    private conversation: ConversationManager,
    private getViewportHeight: () => number,
    private scrollToEnd: (vHeight: number) => void,
    private toolRegistry: ToolRegistry,
    private permissionManager: PermissionManager,
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
   */
  public async handleUserInput(text: string): Promise<void> {
    if (!text.trim()) return;

    if (this.isThinking) {
      this.messageQueue.push(text);
      this.bus.emit('render:request');
      return;
    }

    await this.runTurn(text);

    // Process any messages queued while the LLM was thinking (iterative, not recursive)
    while (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift()!;
      await this.runTurn(next);
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

  private async runTurn(text: string): Promise<void> {
    this.bus.emit('turn:start', { prompt: text });
    this.conversation.addUserMessage(text);
    this.turnStartMessageCount = this.conversation.getMessageCount();
    this.scrollToEnd(this.getViewportHeight());
    this.startThinking();

    try {
      const model = providerRegistry.getCurrentModel();
      const provider: LLMProvider = providerRegistry.getForModel(model.id);
      const toolDefinitions = this.toolRegistry.getToolDefinitions();

      let continueLoop = true;
      while (continueLoop) {
        const response = await provider.chat({
          model: model.id,
          messages: this.conversation.getMessagesForLLM(),
          tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
          systemPrompt: config.systemPrompt,
          reasoningEffort: model.capabilities.reasoning ? 'medium' : undefined,
          signal: this.abortController?.signal,
        });

        this.usage.up += response.usage.inputTokens;
        this.usage.down += response.usage.outputTokens;

        this.bus.emit('turn:llm-response', {
          content: response.content,
          toolCalls: response.toolCalls,
        });

        if (response.toolCalls.length > 0) {
          // Add assistant turn (may include both content and tool calls)
          this.conversation.addAssistantMessage(response.content, response.toolCalls);

          // Execute tools and collect results
          const results = await this.executeToolCalls(response.toolCalls);

          // Add tool results — LLM sees them on next iteration
          this.conversation.addToolResults(results);

          // Loop continues: send results back to LLM
        } else {
          // No tool calls — final response
          this.conversation.addAssistantMessage(response.content);
          this.bus.emit('turn:complete', { response: response.content });
          continueLoop = false;
        }
      }
    } catch (err: unknown) {
      if (this.abortController?.signal.aborted) {
        // Remove any partial messages added during this turn
        this.conversation.removeMessagesAfter(this.turnStartMessageCount);
        this.conversation.addSystemMessage('[Response cancelled]');
        this.bus.emit('turn:error', { error: new Error('Cancelled') });
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error instanceof ProviderError ? error.message : `Error: ${error.message}`;
      this.conversation.addSystemMessage(msg);
      this.bus.emit('turn:error', { error });
    } finally {
      this.stopThinking();
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
