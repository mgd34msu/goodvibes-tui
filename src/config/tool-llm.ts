/**
 * Tool LLM — internal LLM access for tool operations.
 *
 * Provides a lightweight interface for tool-internal LLM calls:
 * semantic diff, auto-heal, commit messages, prompt hooks, etc.
 *
 * Resolution order:
 *   1. tools.llmProvider + tools.llmModel from config (if both set)
 *   2. Currently selected provider/model from providerRegistry
 *
 * Design constraints:
 *   - Never throws from ToolLLM.chat() — returns empty string on any error
 *   - Logs failures via logger.debug (tool LLM failures are expected when no key)
 *   - Singleton pattern — import `toolLLM` for use
 */

import type { LLMProvider } from '../providers/interface.ts';
import { getProviderRegistry } from '../providers/registry.ts';
import { configManager } from './index.ts';
import { logger } from '../utils/logger.ts';

/** Resolved provider + model pair for tool-internal LLM calls. */
export interface ResolvedToolLLM {
  provider: LLMProvider;
  modelId: string;
}

/**
 * Resolve the LLM provider and model to use for tool-internal operations.
 *
 * Resolution order:
 *   1. If tools.llmProvider + tools.llmModel are both set in config, use those.
 *   2. Otherwise fall back to the currently selected provider/model.
 *
 * Returns null if resolution fails (e.g. unknown provider name).
 */
export function resolveToolLLM(): ResolvedToolLLM | null {
  try {
    const providerRegistry = getProviderRegistry();
    const cfgProvider = configManager.get('tools.llmProvider');
    const cfgModel = configManager.get('tools.llmModel');

    if (cfgProvider && cfgModel) {
      // Explicit config: resolve by provider name
      const provider = providerRegistry.get(cfgProvider);
      return { provider, modelId: cfgModel };
    }

    // Fallback: use currently selected provider/model
    const currentDef = providerRegistry.getCurrentModel();
    const provider = providerRegistry.getForModel(currentDef.id, currentDef.provider);
    return { provider, modelId: currentDef.id };
  } catch (err) {
    logger.debug('resolveToolLLM: failed to resolve provider/model', { error: String(err) });
    return null;
  }
}

/** Chat options for tool-internal LLM calls. */
export interface ToolLLMChatOptions {
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * ToolLLM — lightweight LLM interface for internal tool operations.
 *
 * Usage:
 *   const result = await toolLLM.chat('Generate a commit message for: ...');
 *
 * Always returns a string — empty string on any failure.
 */
export class ToolLLM {
  private static _instance: ToolLLM | undefined;

  private constructor() {}

  /** Singleton accessor. */
  static getInstance(): ToolLLM {
    if (!ToolLLM._instance) {
      ToolLLM._instance = new ToolLLM();
    }
    return ToolLLM._instance;
  }

  /**
   * Send a single-turn prompt to the tool LLM.
   *
   * @param prompt   The user prompt to send.
   * @param options  Optional maxTokens and systemPrompt.
   * @returns        The assistant's text response, or empty string on failure.
   */
  async chat(prompt: string, options: ToolLLMChatOptions = {}): Promise<string> {
    try {
      const resolved = resolveToolLLM();
      if (!resolved) {
        logger.debug('ToolLLM.chat: no provider resolved, returning empty string');
        return '';
      }

      const { provider, modelId } = resolved;
      const response = await provider.chat({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens ?? 1024,
        systemPrompt: options.systemPrompt,
      });

      return response.content ?? '';
    } catch (err) {
      logger.debug('ToolLLM.chat: request failed (non-fatal)', { error: String(err) });
      return '';
    }
  }

  /** Reset singleton (used in tests). */
  static _reset(): void {
    ToolLLM._instance = undefined;
  }
}

/** Singleton instance — import and use everywhere. */
export const toolLLM: ToolLLM = ToolLLM.getInstance();
