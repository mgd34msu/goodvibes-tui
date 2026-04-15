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
import type { ProviderCapability } from './capabilities.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { withRetry } from '@pellux/goodvibes-sdk/platform/utils/retry';
import {
  toOpenAITools,
  toOpenAIMessages,
  fromOpenAIToolCalls,
  extractTextToolCalls,
} from './tool-formats.ts';
import type { OpenAIToolCall } from './tool-formats.ts';
import { getCacheCapability } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import type { ProviderCacheCapability } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import type { CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import { extractOpenAIStreamTextDelta } from '@pellux/goodvibes-sdk/platform/providers/openai-stream-delta';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError, toProviderError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'recordTurn'> = {
  recordTurn: () => {},
};

interface ChatRequestFingerprint {
  readonly model: string;
  readonly messageCount: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolMessages: number;
  readonly contentChars: number;
  readonly imageParts: number;
  readonly toolCount: number;
  readonly systemPromptChars: number;
  readonly reasoningEffort: ChatRequest['reasoningEffort'] | null;
  readonly reasoningSummary: boolean;
  readonly maxTokens: number | null;
}

interface OpenAICompatErrorDiagnostic {
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly detail?: string;
  readonly rawMessage: string;
}

function summarizeContent(
  content: ChatRequest['messages'][number]['content'],
): { readonly textChars: number; readonly imageParts: number } {
  if (typeof content === 'string') {
    return { textChars: content.length, imageParts: 0 };
  }

  let textChars = 0;
  let imageParts = 0;
  for (const part of content) {
    if (part.type === 'text') textChars += part.text.length;
    if (part.type === 'image') imageParts += 1;
  }
  return { textChars, imageParts };
}

function buildChatRequestFingerprint(
  request: ChatRequest,
  model: string,
): ChatRequestFingerprint {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let contentChars = 0;
  let imageParts = 0;

  for (const message of request.messages) {
    if (message.role === 'user') {
      userMessages += 1;
      const content = summarizeContent(message.content);
      contentChars += content.textChars;
      imageParts += content.imageParts;
    } else if (message.role === 'assistant') {
      assistantMessages += 1;
      contentChars += message.content.length;
    } else if (message.role === 'tool') {
      toolMessages += 1;
      contentChars += message.content.length;
    }
  }

  return {
    model,
    messageCount: request.messages.length,
    userMessages,
    assistantMessages,
    toolMessages,
    contentChars,
    imageParts,
    toolCount: request.tools?.length ?? 0,
    systemPromptChars: request.systemPrompt?.length ?? 0,
    reasoningEffort: request.reasoningEffort ?? null,
    reasoningSummary: Boolean(request.reasoningSummary),
    maxTokens: request.maxTokens ?? null,
  };
}

function truncateDetail(detail: string, max = 280): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max - 3)}...`;
}

function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function extractHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const loweredName = name.toLowerCase();
    const match = headers.find((entry) =>
      Array.isArray(entry) &&
      entry.length >= 2 &&
      typeof entry[0] === 'string' &&
      entry[0].toLowerCase() === loweredName &&
      typeof entry[1] === 'string');
    return Array.isArray(match) ? match[1] : undefined;
  }
  if (typeof headers === 'object') {
    const loweredName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() !== loweredName) continue;
      if (typeof value === 'string' && value.trim().length > 0) return value;
      if (Array.isArray(value)) {
        const parts = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        if (parts.length > 0) return parts.join(', ');
      }
    }
  }
  return undefined;
}

function formatErrorBodyDetail(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return truncateDetail(value.trim());
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  const detailParts: string[] = [];
  const message = extractStringField(record, 'message');
  const code = extractStringField(record, 'code');
  const type = extractStringField(record, 'type');
  const param = extractStringField(record, 'param');

  if (message) detailParts.push(message);
  if (code && !detailParts.some((part) => part.includes(code))) detailParts.push(`code=${code}`);
  if (type && !detailParts.some((part) => part.includes(type))) detailParts.push(`type=${type}`);
  if (param && !detailParts.some((part) => part.includes(param))) detailParts.push(`param=${param}`);

  if (detailParts.length > 0) return truncateDetail(detailParts.join(', '));

  try {
    return truncateDetail(JSON.stringify(record));
  } catch {
    return undefined;
  }
}

function extractOpenAICompatErrorDiagnostic(err: unknown): OpenAICompatErrorDiagnostic {
  const rawMessage = summarizeError(err);
  const status = err && typeof err === 'object' && 'status' in err && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : undefined;

  if (!err || typeof err !== 'object') {
    return { status, rawMessage };
  }

  const record = err as Record<string, unknown>;
  const detail = formatErrorBodyDetail(record.error) ?? (rawMessage.trim().length > 0 ? truncateDetail(rawMessage.trim()) : undefined);
  return {
    status,
    code: extractStringField(record, 'code'),
    type: extractStringField(record, 'type'),
    requestId: extractStringField(record, 'requestID')
      ?? extractHeaderValue(record.headers, 'x-request-id')
      ?? extractHeaderValue(record.headers, 'request-id'),
    detail,
    rawMessage,
  };
}

function buildOpenAICompatErrorMessage(
  providerName: string,
  phase: 'request' | 'stream',
  diagnostic: OpenAICompatErrorDiagnostic,
): string {
  const prefix = `${providerName} chat ${phase} failed${diagnostic.status !== undefined ? ` ${diagnostic.status}` : ''}`;
  const messageParts = [prefix];

  if (diagnostic.detail && diagnostic.detail !== diagnostic.rawMessage) {
    messageParts.push(diagnostic.detail);
  } else if (diagnostic.rawMessage.trim().length > 0) {
    messageParts.push(truncateDetail(diagnostic.rawMessage.trim()));
  }

  const metadata: string[] = [];
  if (diagnostic.code && !messageParts.some((part) => part.includes(diagnostic.code!))) metadata.push(`code=${diagnostic.code}`);
  if (diagnostic.type && !messageParts.some((part) => part.includes(diagnostic.type!))) metadata.push(`type=${diagnostic.type}`);
  if (diagnostic.requestId) metadata.push(`request_id=${diagnostic.requestId}`);

  return metadata.length > 0
    ? `${messageParts.join(': ')} (${metadata.join(', ')})`
    : messageParts.join(': ');
}

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
  /** Optional anonymous/local access posture. */
  allowAnonymous?: boolean;
  anonymousConfigured?: boolean;
  anonymousDetail?: string;
  /** Override runtime auth posture when apiKey is an internal transport placeholder. */
  authConfigured?: boolean;
  /** Shared cache-hit tracker owned by the runtime service graph. */
  cacheHitTracker?: Pick<CacheHitTracker, 'recordTurn'>;
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
  private readonly allowAnonymous: boolean;
  private readonly anonymousConfigured: boolean;
  private readonly anonymousDetail?: string;
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'recordTurn'>;
  private readonly baseURL: string;
  private readonly endpointHost: string;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.embeddingModel = opts.embeddingModel ?? opts.defaultModel;
    this.configured = opts.authConfigured ?? Boolean(opts.apiKey);
    this.reasoningFormat = opts.reasoningFormat ?? 'none';
    this.cacheCapability = getCacheCapability(opts.name);
    this.authEnvVars = opts.authEnvVars ?? [];
    this.serviceNames = opts.serviceNames ?? [];
    this.subscriptionProviderId = opts.subscriptionProviderId;
    this.suppressedModels = opts.suppressedModels ?? [];
    this.aliases = opts.aliases ?? [];
    this.streamProtocol = opts.streamProtocol;
    this.allowAnonymous = opts.allowAnonymous ?? false;
    this.anonymousConfigured = opts.anonymousConfigured ?? false;
    this.anonymousDetail = opts.anonymousDetail;
    this.cacheHitTracker = opts.cacheHitTracker ?? NOOP_CACHE_HIT_TRACKER;
    this.baseURL = opts.baseURL;
    this.endpointHost = (() => {
      try {
        return new URL(opts.baseURL).host;
      } catch {
        return opts.baseURL;
      }
    })();
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
      const selectedModel = model ?? this.defaultModel;
      const requestFingerprint = buildChatRequestFingerprint(params, selectedModel);

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

      let streamOpened = false;
      logger.debug('OpenAICompatProvider.chat request', {
        provider: this.name,
        endpointHost: this.endpointHost,
        endpoint: this.baseURL,
        request: requestFingerprint,
      });

      try {
        const stream = await this.client.chat.completions.create(
          {
            model: selectedModel,
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
        streamOpened = true;
        logger.debug('OpenAICompatProvider.chat stream opened', {
          provider: this.name,
          endpointHost: this.endpointHost,
          model: selectedModel,
          messageCount: requestFingerprint.messageCount,
          toolCount: requestFingerprint.toolCount,
        });

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
        const diagnostic = extractOpenAICompatErrorDiagnostic(err);
        const phase = streamOpened ? 'stream' : 'request';
        const message = buildOpenAICompatErrorMessage(this.name, phase, diagnostic);
        logger.error('OpenAICompatProvider.chat failed', {
          provider: this.name,
          endpointHost: this.endpointHost,
          endpoint: this.baseURL,
          phase,
          requestAccepted: streamOpened,
          request: requestFingerprint,
          status: diagnostic.status,
          code: diagnostic.code,
          type: diagnostic.type,
          requestId: diagnostic.requestId,
          detail: diagnostic.detail,
          rawMessage: diagnostic.rawMessage,
        });
        throw new ProviderError(message, {
          statusCode: diagnostic.status,
          provider: this.name,
          operation: 'chat',
          phase,
          requestId: diagnostic.requestId,
          providerCode: diagnostic.code,
          providerType: diagnostic.type,
          detail: diagnostic.detail,
          rawMessage: diagnostic.rawMessage,
        });
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

      this.cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return response;
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
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: this.authEnvVars,
      secretKeys: this.authEnvVars,
      serviceNames: this.serviceNames,
      ...(this.subscriptionProviderId ? { subscriptionProviderId: this.subscriptionProviderId } : {}),
      allowAnonymous: this.allowAnonymous,
      anonymousConfigured: this.anonymousConfigured,
      anonymousDetail: this.anonymousDetail,
    }, deps);
    return {
      auth: {
        mode: this.allowAnonymous && !this.configured ? 'anonymous' : 'api-key',
        configured: this.configured || this.anonymousConfigured,
        detail: this.configured
          ? `${this.name} API key available`
          : this.allowAnonymous
            ? (this.anonymousDetail ?? `${this.name} can be used without a stored API key`)
            : `API key for ${this.name} is not configured`,
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
