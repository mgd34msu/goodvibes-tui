import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
} from './tool-formats.ts';
import type { OpenAIToolCall } from './tool-formats.ts';

export interface OpenAICompatOptions {
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
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

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.defaultModel = opts.defaultModel;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
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
      let stopReason: ChatResponse['stopReason'] = 'end';
      let reasoningSummaryText: string | undefined;
      let rawToolCalls: OpenAIToolCall[] = [];

      const openaiMessages = toOpenAIMessages(messages, systemPrompt);
      const openaiTools = tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

      // Mercury-2 extra params passed as additional body properties
      const extraBody: Record<string, unknown> = {};
      if (reasoningEffort) extraBody['reasoning_effort'] = reasoningEffort;
      if (reasoningSummary) {
        extraBody['reasoning_summary'] = true;
        // Wait for the full reasoning summary before streaming text
        extraBody['reasoning_summary_wait'] = true;
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
          { signal },
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
            inputTokens = raw.usage.prompt_tokens ?? 0;
            outputTokens = raw.usage.completion_tokens ?? 0;
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

      const response: ChatResponse = {
        content: responseText,
        toolCalls: rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [],
        usage: { inputTokens, outputTokens },
        stopReason,
      };

      if (reasoningSummaryText) {
        response.reasoningSummary = reasoningSummaryText;
      }

      return response;
    });
  }
}
