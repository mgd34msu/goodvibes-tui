/**
 * Helper Model — lightweight LLM routing for grunt-work tasks.
 *
 * Routes tasks like cache planning, compaction, commit messages, etc. to a
 * cheaper/free model so expensive main models don't waste tokens on routine work.
 *
 * Resolution order:
 *   1. Per-provider helper (helper.providers.{currentProvider}.provider + model)
 *   2. Global helper (helper.globalProvider + helper.globalModel)
 *   3. Tool LLM (tools.llmProvider + tools.llmModel) — if configured
 *   4. Main model (fallback — not a true helper, but ensures the task runs)
 *
 * Design constraints:
 *   - Never throws from HelperModel.chat() — returns empty string on any error
 *   - Logs failures via logger.debug (non-fatal)
 *   - Singleton pattern — import `helperModel` for use
 *   - Tracks token usage separately from the main model
 */

import type { ConfigManager } from './manager.ts';
import type { LLMProvider } from '../providers/interface.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';
import { summarizeError } from '../utils/error-display.ts';

/** Tasks that can be routed to a helper model. */
export type HelperTask =
  | 'cache_strategy'     // Plan cache breakpoints + TTL
  | 'compaction'         // Summarize old context for compaction
  | 'intent_classify'    // Classify user intent (question vs task)
  | 'tool_summarize'     // Condense large tool output
  | 'commit_message'     // Generate commit messages
  | 'review_triage';     // Triage which files need deep review

/** Resolved helper model: provider instance + model ID. */
export interface ResolvedHelper {
  provider: LLMProvider;
  modelId: string;
  /** true if using a dedicated helper, false if falling back to main model. */
  isHelper: boolean;
}

/** Options for helper model invocation. */
export interface HelperChatOptions {
  maxTokens?: number;
  systemPrompt?: string;
  /** If true, return empty string instead of falling back to main model. */
  helperOnly?: boolean;
}

/** Token usage tracking for helper model calls. */
export interface HelperUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface HelperModelDeps {
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel'>;
}

/**
 * HelperRouter — resolves which model to use for a given helper task.
 *
 * Resolution order:
 *   1. Per-provider helper (helper.providers.{currentProvider}.provider + model)
 *   2. Global helper (helper.globalProvider + helper.globalModel)
 *   3. Tool LLM (tools.llmProvider + tools.llmModel) — if configured
 *   4. Main model (fallback — not a true helper, but ensures the task runs)
 */
export class HelperRouter {
  constructor(private readonly deps: HelperModelDeps) {}

  /**
   * Resolve the best helper for the given task.
   *
   * Returns null only if no provider can be resolved at all.
   */
  resolve(_task: HelperTask): ResolvedHelper | null {
    try {
      // 1. Check per-provider helper
      const currentModel = this.deps.providerRegistry.getCurrentModel();
      const currentProviderName = currentModel.provider ?? '';

      // Per-provider helpers stored in config as helper.providers.{name}.provider and .model
      // These are accessed via getCategory since they're nested objects
      const helperConfig = this.deps.configManager.getCategory('helper') as Record<string, unknown> | undefined;
      if (helperConfig) {
        const providers = helperConfig['providers'] as Record<string, { provider?: string; model?: string }> | undefined;
        if (providers && currentProviderName && providers[currentProviderName]) {
          const perProvider = providers[currentProviderName];
          if (perProvider.provider && perProvider.model) {
            try {
              const provider = this.deps.providerRegistry.get(perProvider.provider);
              return { provider, modelId: perProvider.model, isHelper: true };
            } catch {
              logger.debug(`HelperRouter: per-provider helper ${perProvider.provider} not found, falling through`);
            }
          }
        }
      }

      // 2. Global helper
      const globalProvider = this.deps.configManager.get('helper.globalProvider') as string;
      const globalModel = this.deps.configManager.get('helper.globalModel') as string;
      if (globalProvider && globalModel) {
        try {
          const provider = this.deps.providerRegistry.get(globalProvider);
          return { provider, modelId: globalModel, isHelper: true };
        } catch {
          logger.debug(`HelperRouter: global helper ${globalProvider} not found, falling through`);
        }
      }

      // 3. Tool LLM
      const toolProvider = this.deps.configManager.get('tools.llmProvider') as string;
      const toolModel = this.deps.configManager.get('tools.llmModel') as string;
      if (toolProvider && toolModel) {
        try {
          const provider = this.deps.providerRegistry.get(toolProvider);
          return { provider, modelId: toolModel, isHelper: true };
        } catch {
          logger.debug(`HelperRouter: tool LLM ${toolProvider} not found, falling through`);
        }
      }

      // 4. Fallback to main model
      const mainProvider = this.deps.providerRegistry.getForModel(currentModel.id, currentModel.provider);
      return { provider: mainProvider, modelId: currentModel.id, isHelper: false };
    } catch (err) {
      logger.debug('HelperRouter.resolve: failed', { task: _task, error: summarizeError(err) });
      return null;
    }
  }
}

/**
 * HelperModel — lightweight LLM interface for helper tasks.
 *
 * Callers own HelperModel lifetimes explicitly. Never throws — returns empty string on failure.
 * Tracks token usage separately from the main model.
 */
export class HelperModel {
  private readonly router: HelperRouter;
  private _usage: HelperUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(private readonly deps: HelperModelDeps) {
    this.router = new HelperRouter(deps);
  }

  /**
   * Send a prompt to the helper model for the given task.
   *
   * @param task     The helper task type (for routing).
   * @param prompt   The user prompt to send.
   * @param options  Optional maxTokens, systemPrompt, helperOnly.
   * @returns        The assistant's text response, or empty string on failure.
   */
  async chat(task: HelperTask, prompt: string, options: HelperChatOptions = {}): Promise<string> {
    // When helper is disabled, skip the resolution chain entirely
    const enabled = this.deps.configManager.get('helper.enabled') as boolean;
    if (!enabled) {
      if (options.helperOnly) return '';
      // Disabled: bypass helper resolution — use main model directly
      try {
        const currentModel = this.deps.providerRegistry.getCurrentModel();
        const mainProvider = this.deps.providerRegistry.getForModel(currentModel.id, currentModel.provider);
        const response = await mainProvider.chat({
          model: currentModel.id,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: options.maxTokens ?? 2048,
          systemPrompt: options.systemPrompt,
        });
        this._usage.inputTokens += response.usage?.inputTokens ?? 0;
        this._usage.outputTokens += response.usage?.outputTokens ?? 0;
        this._usage.calls += 1;
        return response.content ?? '';
      } catch (err) {
        logger.debug('HelperModel.chat: main model fallback failed (non-fatal)', { task, error: summarizeError(err) });
        return '';
      }
    }

    try {
      const resolved = this.router.resolve(task);
      if (!resolved) {
        logger.debug('HelperModel.chat: no provider resolved', { task });
        return '';
      }

      // If helperOnly is set and we fell back to the main model, return empty
      if (options.helperOnly && !resolved.isHelper) {
        return '';
      }

      const response = await resolved.provider.chat({
        model: resolved.modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens ?? 2048,
        systemPrompt: options.systemPrompt,
      });

      // Track usage
      this._usage.inputTokens += response.usage?.inputTokens ?? 0;
      this._usage.outputTokens += response.usage?.outputTokens ?? 0;
      this._usage.calls += 1;

      logger.debug('HelperModel.chat: success', {
        task,
        isHelper: resolved.isHelper,
        modelId: resolved.modelId,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      });

      return response.content ?? '';
    } catch (err) {
      logger.debug('HelperModel.chat: request failed (non-fatal)', { task, error: summarizeError(err) });
      return '';
    }
  }

  /** Get cumulative helper usage since last reset. */
  getUsage(): Readonly<HelperUsage> {
    return { ...this._usage };
  }

  /** Reset usage counters. */
  resetUsage(): void {
    this._usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  }
}
