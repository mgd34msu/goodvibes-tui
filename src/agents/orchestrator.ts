import { ConversationManager } from '../core/conversation.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { providerRegistry } from '../providers/registry.ts';
import { registerAllTools } from '../tools/index.ts';
import { logger } from '../utils/logger.ts';
import type { AgentRecord } from '../tools/agent/index.ts';
import type { LLMProvider } from '../providers/interface.ts';

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

  /**
   * Run an agent task described by the given record.
   * Updates record status, toolCallCount, progress, and error in-place.
   * Never throws — all errors are captured into record.error.
   */
  async runAgent(record: AgentRecord): Promise<void> {
    record.status = 'running';
    record.progress = 'Initialising…';

    try {
      // --- Resolve model and provider ---
      const modelId = record.model ?? providerRegistry.getCurrentModel().id;
      let provider: LLMProvider;
      try {
        provider = providerRegistry.getForModel(modelId);
      } catch (err) {
        throw new Error(
          `Cannot resolve provider for model '${modelId}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // --- Build scoped tool registry ---
      const toolRegistry = this.buildScopedRegistry(record.tools, this.getFullRegistry());
      const toolDefinitions = toolRegistry.getToolDefinitions();

      // --- Conversation ---
      const conversation = new ConversationManager(() => 80); // default terminal width for agent conversation
      conversation.addUserMessage(record.task);

      // --- System prompt ---
      const systemPrompt = this.buildSystemPrompt(record);

      // --- Turn loop ---
      let continueLoop = true;
      let turn = 0;
      record.progress = 'Thinking…';

      while (continueLoop) {
        if ((record as { status: string }).status === 'cancelled') {
          return;
        }
        if (++turn > MAX_TURNS) {
          record.status = 'failed';
          record.error = `Exceeded maximum turn limit (${MAX_TURNS})`;
          return;
        }
        const response = await provider.chat({
          model: modelId,
          messages: conversation.getMessagesForLLM(),
          tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
          systemPrompt,
        });

        if (response.toolCalls.length > 0) {
          conversation.addAssistantMessage(response.content, { toolCalls: response.toolCalls, usage: response.usage });

          // Execute tools sequentially
          const results = [];
          for (const call of response.toolCalls) {
            record.progress = `Executing tool: ${call.name}`;
            record.toolCallCount++;

            try {
              const result = await toolRegistry.execute(call.id, call.name, call.arguments);
              results.push(result);
            } catch (err) {
              results.push({
                callId: call.id,
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          conversation.addToolResults(results);
          record.progress = 'Thinking…';
        } else {
          // Final response — no more tool calls
          conversation.addAssistantMessage(response.content, { usage: response.usage });
          record.progress = response.content.slice(0, 200) || 'Done.';
          continueLoop = false;
        }
      }

      record.status = 'completed';
      record.completedAt = Date.now();
      logger.info(`Agent ${record.id} completed`, { toolCallCount: record.toolCallCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = 'failed';
      record.error = message;
      record.completedAt = Date.now();
      logger.error(`Agent ${record.id} failed`, { error: message });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Lazily build and cache the full ToolRegistry. */
  private getFullRegistry(): ToolRegistry {
    if (!this.fullRegistry) {
      this.fullRegistry = new ToolRegistry();
      registerAllTools(this.fullRegistry);
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

  /** Build a system prompt from the agent record. */
  private buildSystemPrompt(record: AgentRecord): string {
    const lines: string[] = [
      `You are a ${record.template} agent. Complete the given task autonomously.`,
      `Your task is: ${record.task}`,
      `You have access to the following tools: ${record.tools.filter((t) => t !== 'agent').join(', ')}.`,
      'When you have fully completed the task, provide a concise summary of what you did.',
    ];
    return lines.join('\n');
  }
}

/** Module-level singleton — import and use everywhere. */
export const agentOrchestrator = AgentOrchestrator.getInstance();
