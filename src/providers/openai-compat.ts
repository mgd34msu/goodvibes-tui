import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
  extractTextToolCalls,
} from './tool-formats.ts';
import type { OpenAIToolCall } from './tool-formats.ts';
import { getCacheCapability } from './cache-capability.ts';
import type { ProviderCacheCapability } from './cache-capability.ts';
import { cacheHitTracker } from './cache-strategy.ts';

export interface OpenAICompatOptions {
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
  /** Optional extra HTTP headers sent with every request to this provider. */
  defaultHeaders?: Record<string, string>;
  /** How to send reasoning params. Default: 'none' (don't send). */
  reasoningFormat?: 'mercury' | 'openrouter' | 'llamacpp' | 'none';
}

/**
 * OpenAICompatProvider — generic OpenAI-compatible provider.
 * Configured for InceptionLabs Mercury-2 with reasoning_effort and
 * reasoning_summary extensions, but usable with any OAI-compatible API.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];

  private client: OpenAI;
  private defaultModel: string;
  private reasoningFormat: 'mercury' | 'openrouter' | 'llamacpp' | 'none';
  private cacheCapability: ProviderCacheCapability;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.defaultModel = opts.defaultModel;
    this.reasoningFormat = opts.reasoningFormat ?? 'none';
    this.cacheCapability = getCacheCapability(opts.name);
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
    });
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const {
      messages,
      tools,
      model,
      maxTokens,
      signal,
      systemPrompt,
      reasoningEffort,
      reasoningSummary,
      onDelta,
    } = params;

    return withRetry(async () => {
      let responseText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let stopReason: ChatResponse['stopReason'] = 'end';
      let reasoningSummaryText: string | undefined;
      let rawToolCalls: OpenAIToolCall[] = [];

      const openaiMessages = toOpenAIMessages(messages, systemPrompt);
      const openaiTools = tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

      // Provider-specific reasoning params
      const extraBody: Record<string, unknown> = {};
      if (reasoningEffort && this.reasoningFormat === 'mercury') {
        extraBody['reasoning_effort'] = reasoningEffort;
      } else if (reasoningEffort && this.reasoningFormat === 'openrouter') {
        extraBody['reasoning'] = { effort: reasoningEffort };
      } else if (this.reasoningFormat === 'llamacpp') {
        // llama.cpp auto-enables thinking for capable models; explicitly control it
        extraBody['enable_thinking'] = reasoningEffort !== undefined && reasoningEffort !== 'instant';
      }
      // reasoningFormat === 'none': don't send anything

      if (reasoningSummary && this.reasoningFormat === 'mercury') {
        extraBody['reasoning_summary'] = true;
        // Wait for the full reasoning summary before streaming text
        extraBody['reasoning_summary_wait'] = true;
      }

      // Build per-request headers for cache optimization
      const requestHeaders: Record<string, string> = {};
      if (this.cacheCapability.type === 'automatic' && this.cacheCapability.sessionAffinityHeader) {
        requestHeaders[this.cacheCapability.sessionAffinityHeader] = 'true';
      }

      try {
        const stream = await this.client.chat.completions.create(
          {
            model: model ?? this.defaultModel,
            messages: openaiMessages as Parameters<typeof this.client.chat.completions.create>[0]['messages'],
            ...(openaiTools ? { tools: openaiTools as Parameters<typeof this.client.chat.completions.create>[0]['tools'] } : {}),
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
            ...extraBody,
          },
          {
            signal,
            ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
          },
        );

        const accToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

        for await (const chunk of stream) {
          const raw = chunk as typeof chunk & {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            reasoning_summary?: string;
          };

          const delta = raw.choices[0]?.delta;

          if (delta?.content) {
            responseText += delta.content;
            if (onDelta) onDelta({ content: delta.content });
          }

          // Mercury-2: reasoning_summary may appear on any chunk — capture and emit
          if (raw.reasoning_summary) {
            reasoningSummaryText = raw.reasoning_summary;
            if (onDelta) onDelta({ reasoning: raw.reasoning_summary });
          }

          // Accumulate streaming tool_calls deltas
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!accToolCalls.has(idx)) {
                accToolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              }
              const entry = accToolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
              if (onDelta) {
                onDelta({ toolCalls: [{ index: idx, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments }] });
              }
            }
          }

          const finishReason = raw.choices[0]?.finish_reason;
          if (finishReason === 'tool_calls') stopReason = 'tool_use';
          else if (finishReason === 'length') stopReason = 'max_tokens';

          if (raw.usage) {
            const rawUsage = raw.usage as {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
            inputTokens = rawUsage.prompt_tokens ?? 0;
            outputTokens = rawUsage.completion_tokens ?? 0;
            cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
          }
        }

        for (const [, tc] of [...accToolCalls.entries()].sort(([a], [b]) => a - b)) {
          rawToolCalls.push({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          });
        }
      } catch (err: unknown) {
        const { hasStatus } = await import('../utils/retry.ts');
        const status = hasStatus(err) ? err.status : undefined;
        throw new ProviderError(
          err instanceof Error ? err.message : String(err),
          status,
        );
      }

      // Some models (e.g. kimi-k2-thinking via ollama-cloud) emit tool calls as
      // raw text tokens instead of the OpenAI function-calling wire format.
      // Fall back to text extraction when no structured tool calls were found.
      let toolCalls = rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [];
      if (toolCalls.length === 0 && (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))) {
        const extracted = extractTextToolCalls(responseText);
        if (extracted.toolCalls.length > 0) {
          toolCalls = extracted.toolCalls;
          responseText = extracted.cleanedContent;
          stopReason = 'tool_use';
        }
      }

      const response: ChatResponse = {
        content: responseText,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason,
      };

      if (reasoningSummaryText) {
        response.reasoningSummary = reasoningSummaryText;
      }

      cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return response;
    });
  }
}
