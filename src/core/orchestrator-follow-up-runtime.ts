import type { ConversationManager } from './conversation.ts';
import type { ModelDefinition, ProviderRegistry } from '../providers/registry.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  buildConversationFollowUpPrompt,
  normalizeConversationFollowUpItems,
  type ConversationFollowUpItem,
} from '@pellux/goodvibes-sdk/platform/core/conversation-follow-ups';
import { normalizeUsage } from './orchestrator-runtime.ts';

const FOLLOW_UP_DEDUP_TTL_MS = 60_000;
const FOLLOW_UP_MAX_OUTPUT_TOKENS = 160;
const FOLLOW_UP_RETRY_DELAY_MS = 250;

export interface OrchestratorFollowUpRuntimeOptions {
  readonly conversation: ConversationManager;
  readonly getViewportHeight: () => number;
  readonly scrollToEnd: (height: number) => void;
  readonly getSystemPrompt: () => string;
  readonly requestRender: () => void;
  readonly getThinkingState: () => { readonly isThinking: boolean; readonly isCompacting: boolean };
  readonly getQueuedUserMessageCount: () => number;
  readonly getProviderRegistry: () => ProviderRegistry;
  readonly getCurrentModel: () => ModelDefinition;
  readonly routeLowPriorityMessage: (message: string) => void;
  readonly applyUsage: (usage: ReturnType<typeof normalizeUsage>) => void;
}

export class OrchestratorFollowUpRuntime {
  private queue: ConversationFollowUpItem[] = [];
  private flushScheduled = false;
  private isRunning = false;
  private readonly recentKeys = new Map<string, number>();

  public constructor(private readonly options: OrchestratorFollowUpRuntimeOptions) {}

  public enqueue(item: ConversationFollowUpItem): void {
    const summary = item.summary.trim();
    if (summary.length === 0) return;
    const now = Date.now();
    this.pruneRecent(now);
    const lastSeenAt = this.recentKeys.get(item.key);
    if (lastSeenAt !== undefined && now - lastSeenAt < FOLLOW_UP_DEDUP_TTL_MS) return;
    this.recentKeys.set(item.key, now);
    this.queue.push({ key: item.key, summary });
    this.scheduleFlush();
  }

  public scheduleFlush(): void {
    if (this.flushScheduled || this.queue.length === 0) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private pruneRecent(now: number): void {
    for (const [key, seenAt] of this.recentKeys.entries()) {
      if (now - seenAt >= FOLLOW_UP_DEDUP_TTL_MS) {
        this.recentKeys.delete(key);
      }
    }
  }

  private takeBatch(): ConversationFollowUpItem[] {
    const batch = normalizeConversationFollowUpItems(this.queue);
    if (batch.length === 0) {
      this.queue = [];
      return [];
    }
    const batchKeys = new Set(batch.map((item) => item.key));
    this.queue = this.queue.filter((item) => !batchKeys.has(item.key));
    return batch;
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const state = this.options.getThinkingState();
    if (state.isThinking || state.isCompacting || this.isRunning || this.options.getQueuedUserMessageCount() > 0) {
      setTimeout(() => this.scheduleFlush(), FOLLOW_UP_RETRY_DELAY_MS);
      return;
    }

    const providerRegistry = this.options.getProviderRegistry();
    const model = this.options.getCurrentModel();
    const provider = providerRegistry.get(model.provider);
    const tokenLimit = Math.min(
      FOLLOW_UP_MAX_OUTPUT_TOKENS,
      providerRegistry.getTokenLimitsForModel(model).maxOutputTokens,
    );
    const batch = this.takeBatch();
    if (batch.length === 0) return;

    this.isRunning = true;
    try {
      const response = await provider.chat({
        model: model.id,
        messages: [
          ...this.options.conversation.getMessagesForLLM(),
          { role: 'user', content: buildConversationFollowUpPrompt(batch) },
        ],
        systemPrompt: this.options.getSystemPrompt(),
        maxTokens: tokenLimit,
        reasoningEffort: model.capabilities.reasoning ? 'low' : undefined,
      });

      const content = response.content.trim();
      if (content.length > 0) {
        this.options.conversation.addAssistantMessage(content, {
          usage: response.usage,
          model: model.displayName,
          provider: model.provider,
        });
        const normalizedUsage = normalizeUsage(response.usage);
        this.options.applyUsage(normalizedUsage);
        this.options.scrollToEnd(this.options.getViewportHeight());
        this.options.requestRender();
      }
    } catch (error) {
      logger.debug('Orchestrator follow-up acknowledgement failed', {
        error: summarizeError(error),
        updates: batch.map((item) => item.summary),
      });
      this.options.routeLowPriorityMessage(`[Follow-up] Acknowledgement update failed: ${summarizeError(error)}`);
    } finally {
      this.isRunning = false;
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }
}
