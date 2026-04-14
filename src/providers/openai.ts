import OpenAI from 'openai';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
  extractTextToolCalls,
} from './tool-formats.ts';
import type { OpenAIToolCall } from './tool-formats.ts';
import type { CacheHitTracker } from './cache-strategy.ts';
import { extractOpenAIStreamTextDelta } from './openai-stream-delta.ts';
import { summarizeError, toProviderError } from '../utils/error-display.ts';

const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'recordTurn'> = {
  recordTurn: () => {},
};

/**
 * OpenAIProvider — wraps the official `openai` npm package.
 * Supports GPT-5 family models with full function/tool calling.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly models: string[] = [];

  private client: OpenAI;
  private readonly embeddingModel = 'text-embedding-3-small';
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'>;

  constructor(apiKey: string, cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'> = NOOP_CACHE_HIT_TRACKER) {
    this.client = new OpenAI({ apiKey });
    this.cacheHitTracker = cacheHitTracker;
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
          const textDelta = extractOpenAIStreamTextDelta(chunk);
          for (const contentDelta of textDelta.content) {
            responseText += contentDelta;
            if (onDelta) onDelta({ content: contentDelta });
          }
          for (const reasoningDelta of textDelta.reasoning) {
            if (onDelta) onDelta({ reasoning: reasoningDelta });
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
        throw toProviderError(err, {
          ...(status !== undefined ? { statusCode: status } : {}),
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }

      // Some models may emit tool calls as raw text tokens instead of the
      // OpenAI function-calling wire format. Fall back to text extraction.
      let toolCalls = rawToolCalls.length > 0 ? fromOpenAIToolCalls(rawToolCalls) : [];
      if (toolCalls.length === 0 && (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))) {
        const extracted = extractTextToolCalls(responseText);
        if (extracted.toolCalls.length > 0) {
          toolCalls = extracted.toolCalls;
          responseText = extracted.cleanedContent;
          stopReason = 'tool_use';
        }
      }

      this.cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return {
        content: responseText,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason,
      };
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    let response;
    try {
      response = await this.client.embeddings.create(
        {
          model: request.model ?? this.embeddingModel,
          input: request.text,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error: unknown) {
      throw toProviderError(error, {
        provider: this.name,
        operation: 'embed',
        phase: 'request',
      });
    }
    const embedding = response.data[0]?.embedding ?? [];
    return {
      vector: Float32Array.from(embedding),
      dimensions: embedding.length,
      modelId: response.model,
      metadata: {
        usage: request.usage,
        provider: this.name,
      },
    };
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const configured = Boolean(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY);
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: 'openai',
      apiKeyEnvVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
      serviceNames: ['openai'],
      subscriptionProviderId: 'openai',
    }, deps);
    return {
      auth: {
        mode: 'api-key',
        configured,
        detail: configured ? 'OpenAI API key available' : 'OPENAI_API_KEY or OPENAI_KEY not set',
        envVars: ['OPENAI_API_KEY', 'OPENAI_KEY'],
        routes: authRoutes,
      },
      models: {
        models: this.models,
        embeddingModel: this.embeddingModel,
        embeddingDimensions: 384,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        notes: ['Embeddings use the OpenAI embeddings API.'],
      },
      policy: {
        local: false,
        streamProtocol: 'openai-chat-completions',
        reasoningMode: 'provider-default',
        cacheStrategy: 'implicit-openai-cache-observation',
        notes: ['OpenAI embedding usage is subject to OpenAI API terms.'],
      },
    };
  }
}
