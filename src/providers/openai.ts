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

/**
 * OpenAIProvider — wraps the official `openai` npm package.
 * Supports GPT-5 family models with full function/tool calling.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly models: string[] = [];

  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort: _reasoningEffort } = params;
    // Note: OpenAI GPT-5 does not expose reasoning effort as a configurable API parameter

    return withRetry(async () => {
      let responseText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let stopReason: ChatResponse['stopReason'] = 'end';
      let rawToolCalls: OpenAIToolCall[] = [];

      const openaiMessages = toOpenAIMessages(messages, systemPrompt);
      const openaiTools = tools && tools.length > 0 ? toOpenAITools(tools) : undefined;

      try {
        const stream = await this.client.chat.completions.create(
          {
            model,
            messages: openaiMessages as Parameters<typeof this.client.chat.completions.create>[0]['messages'],
            ...(openaiTools ? { tools: openaiTools as Parameters<typeof this.client.chat.completions.create>[0]['tools'] } : {}),
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );

        const accToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            responseText += delta.content;
            if (onDelta) onDelta({ content: delta.content });
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

          const finishReason = chunk.choices[0]?.finish_reason;
          if (finishReason === 'tool_calls') stopReason = 'tool_use';
          else if (finishReason === 'length') stopReason = 'max_tokens';

          const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? 0;
            outputTokens = usage.completion_tokens ?? 0;
            cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
          }
        }

        // Finalise accumulated tool calls
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

      return {
        content: responseText,
        toolCalls: rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [],
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason,
      };
    });
  }
}
