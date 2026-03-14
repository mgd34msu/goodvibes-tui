import type { ConversationManager } from './conversation.ts';
import type { EventBus } from './event-bus.ts';
import { ProviderError } from '../types/errors.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { LLMProvider } from '../providers/interface.ts';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Orchestrator - Manages LLM turn lifecycle and spinner state.
 * Phase 1: Wraps existing sendMessage logic. Phase 2 will complete the agent loop.
 */
export class Orchestrator {
  public isThinking = false;
  public thinkingFrame = 0;
  public usage = { up: 0, down: 0 };
  public messageQueue: string[] = [];

  private animInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private bus: EventBus,
    private conversation: ConversationManager,
    private getViewportHeight: () => number,
    private scrollToEnd: (vHeight: number) => void,
  ) {}

  public getSpinner(): string {
    return SPINNER_FRAMES[this.thinkingFrame % SPINNER_FRAMES.length];
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

  private async runTurn(text: string): Promise<void> {
    this.bus.emit('turn:start', { prompt: text });

    this.conversation.addUserMessage(text);
    const vHeight = this.getViewportHeight();
    this.scrollToEnd(vHeight);

    this.isThinking = true;
    if (this.animInterval) clearInterval(this.animInterval);
    this.animInterval = setInterval(() => {
      this.thinkingFrame++;
      this.bus.emit('render:request');
    }, 80);
    this.bus.emit('render:request');

    try {
      const model = providerRegistry.getCurrentModel();
      const provider: LLMProvider = providerRegistry.getForModel(model.id);
      const rawMessages = this.conversation.getMessagesForLLM();
      // Map ConversationManager's simple messages to the ProviderMessage union type
      const providerMessages = rawMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const response = await provider.chat({
        model: model.id,
        messages: providerMessages,
        reasoningEffort: model.capabilities.reasoning ? 'medium' : undefined,
      });

      this.conversation.addAssistantMessage(response.content);
      this.usage.up += response.usage.inputTokens;
      this.usage.down += response.usage.outputTokens;
      this.bus.emit('turn:complete', { response: response.content });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const msg = error instanceof ProviderError ? error.message : `Error: ${error.message}`;
      this.conversation.addSystemMessage(msg);
      this.bus.emit('turn:error', { error });
    } finally {
      if (this.animInterval) clearInterval(this.animInterval);
      this.animInterval = null;
      this.isThinking = false;
      this.scrollToEnd(this.getViewportHeight());
      this.bus.emit('render:request');

    }
  }
}
