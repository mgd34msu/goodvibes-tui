import OpenAI from 'openai';
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderRuntimeMetadata,
} from './interface.ts';
import type { ProviderCapability } from './capabilities.ts';
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
import { extractOpenAIStreamTextDelta } from './openai-stream-delta.ts';

export interface OpenAICompatOptions {
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
  embeddingModel?: string;
  capabilities?: Partial<ProviderCapability>;
  /** Optional extra HTTP headers sent with every request to this provider. */
  defaultHeaders?: Record<string, string>;
  /** How to send reasoning params. Default: 'none' (don't send). */
  reasoningFormat?: 'mercury' | 'openrouter' | 'llamacpp' | 'none';
  /** Optional env vars or secret keys that can satisfy API-key auth for this provider. */
  authEnvVars?: readonly string[];
  /** Optional service names that expose service-owned OAuth for this provider. */
  serviceNames?: readonly string[];
  /** Optional subscription-provider identity when this provider can use a stored OAuth session. */
  subscriptionProviderId?: string;
  /** Optional provider-owned model suppression list for runtime clients. */
  suppressedModels?: readonly string[];
  /** Optional provider aliases exposed to runtime metadata consumers. */
  aliases?: readonly string[];
  /** Optional explicit stream protocol label for diagnostics. */
  streamProtocol?: string;
}

/**
 * OpenAICompatProvider — generic OpenAI-compatible provider.
 * Configured for InceptionLabs Mercury-2 with reasoning_effort and
 * reasoning_summary extensions, but usable with any OAI-compatible API.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability>;

  private client: OpenAI;
  private defaultModel: string;
  private embeddingModel: string;
  private readonly configured: boolean;
  private reasoningFormat: 'mercury' | 'openrouter' | 'llamacpp' | 'none';
  private cacheCapability: ProviderCacheCapability;
  private readonly authEnvVars: readonly string[];
  private readonly serviceNames: readonly string[];
  private readonly subscriptionProviderId?: string;
  private readonly suppressedModels: readonly string[];
  private readonly aliases: readonly string[];
  private readonly streamProtocol?: string;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.embeddingModel = opts.embeddingModel ?? opts.defaultModel;
    this.configured = Boolean(opts.apiKey);
    this.reasoningFormat = opts.reasoningFormat ?? 'none';
    this.cacheCapability = getCacheCapability(opts.name);
    this.authEnvVars = opts.authEnvVars ?? [];
    this.serviceNames = opts.serviceNames ?? [];
    this.subscriptionProviderId = opts.subscriptionProviderId;
    this.suppressedModels = opts.suppressedModels ?? [];
    this.aliases = opts.aliases ?? [];
    this.streamProtocol = opts.streamProtocol;
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
      const allowReasoningStream = this.reasoningFormat !== 'none';
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
          const textDelta = extractOpenAIStreamTextDelta(raw, { allowReasoning: allowReasoningStream });
          for (const contentDelta of textDelta.content) {
            responseText += contentDelta;
            if (onDelta) onDelta({ content: contentDelta });
          }
          for (const reasoningDelta of textDelta.reasoning) {
            if (onDelta) onDelta({ reasoning: reasoningDelta });
          }

          // Mercury-2: reasoning_summary may appear on any chunk — capture and emit
          if (allowReasoningStream && raw.reasoning_summary) {
            reasoningSummaryText = raw.reasoning_summary;
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

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    const response = await this.client.embeddings.create(
      {
        model: request.model ?? this.embeddingModel,
        input: request.text,
        ...(request.dimensions ? { dimensions: request.dimensions } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );
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

  async describeRuntime(): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: this.authEnvVars,
      secretKeys: this.authEnvVars,
      serviceNames: this.serviceNames,
      ...(this.subscriptionProviderId ? { subscriptionProviderId: this.subscriptionProviderId } : {}),
    });
    return {
      auth: {
        mode: 'api-key',
        configured: this.configured,
        detail: this.configured ? `${this.name} API key available` : `API key for ${this.name} is not configured`,
        ...(this.authEnvVars.length > 0 ? { envVars: this.authEnvVars } : {}),
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
        embeddingModel: this.embeddingModel,
        ...(this.aliases.length > 0 ? { aliases: this.aliases } : {}),
        ...(this.suppressedModels.length > 0 ? { suppressedModels: this.suppressedModels } : {}),
      },
      usage: {
        streaming: true,
        toolCalling: this.capabilities?.toolCalling ?? true,
        parallelTools: this.capabilities?.parallelTools ?? false,
        promptCaching: this.cacheCapability.type !== 'none',
        notes: this.reasoningFormat !== 'none'
          ? ['Provider supports reasoning-aware request routing.']
          : undefined,
      },
      policy: {
        local: false,
        streamProtocol: this.streamProtocol ?? 'openai-chat-completions',
        reasoningMode: this.reasoningFormat === 'none' ? 'provider-default' : this.reasoningFormat,
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: this.cacheCapability.type,
      },
    };
  }
}
