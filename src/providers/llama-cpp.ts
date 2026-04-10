import { withRetry } from '../utils/retry.ts';
import { ProviderError } from '../types/errors.ts';
import type { ToolCall } from '../types/tools.ts';
import type { ProviderCapability } from './capabilities.ts';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  PartialToolCall,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderMessage,
  ProviderRuntimeMetadata,
} from './interface.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.ts';
import {
  extractTextToolCalls,
  fromOpenAIToolCalls,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIToolCall,
} from './tool-formats.ts';

type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type LlamaCppChatCompletion = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

export interface LlamaCppProviderOptions extends OpenAICompatOptions {
  nativeFetch?: NativeFetch;
  fallbackProvider?: LLMProvider;
}

export class LlamaCppProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability>;

  private readonly defaultModel: string;
  private readonly reasoningFormat: OpenAICompatOptions['reasoningFormat'];
  private readonly nativeChatUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly fallbackProvider: LLMProvider;
  private readonly apiKey: string;
  private readonly defaultHeaders?: Record<string, string>;

  constructor(opts: LlamaCppProviderOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.reasoningFormat = opts.reasoningFormat ?? 'none';
    this.nativeChatUrl = deriveLlamaCppChatUrl(opts.baseURL);
    this.nativeFetch = opts.nativeFetch ?? ((input, init) => fetch(input, init));
    this.fallbackProvider = opts.fallbackProvider ?? new OpenAICompatProvider(opts);
    this.apiKey = opts.apiKey;
    this.defaultHeaders = opts.defaultHeaders;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      if (!shouldUseNonStreamingLlamaCpp(params)) {
        return this.fallbackProvider.chat(params);
      }
      return this.chatViaNonStreamingCompat(params, params.model || this.defaultModel);
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    if (!this.fallbackProvider.embed) {
      throw new ProviderError('llama.cpp fallback provider does not support embeddings.', 501);
    }
    return this.fallbackProvider.embed(request);
  }

  async describeRuntime(): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      allowAnonymous: !this.apiKey,
      anonymousConfigured: !this.apiKey,
      anonymousDetail: 'Local llama.cpp servers are often exposed without authentication.',
    });
    return {
      auth: {
        mode: this.apiKey ? 'api-key' : 'anonymous',
        configured: true,
        detail: this.apiKey ? 'llama.cpp compat path has an API key configured.' : 'llama.cpp compat path is running without an API key.',
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: false,
        notes: ['llama.cpp uses a non-streaming recovery path for tool turns and delegates embeddings to the fallback compat provider.'],
      },
      policy: {
        local: true,
        streamProtocol: 'openai-chat-completions',
        reasoningMode: this.reasoningFormat ?? 'provider-default',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'provider-managed',
      },
    };
  }

  private async chatViaNonStreamingCompat(
    params: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    const extraBody = buildReasoningBody(this.reasoningFormat, params.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      ...(params.tools && params.tools.length > 0 ? { tools: toOpenAITools(params.tools) } : {}),
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      stream: false,
      ...extraBody,
    };

    let response: Response;
    try {
      response = await this.nativeFetch(this.nativeChatUrl, {
        method: 'POST',
        headers: buildHeaders(this.apiKey, this.defaultHeaders),
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err: unknown) {
      throw normalizeProviderError(err);
    }

    if (!response.ok) {
      throw await buildHttpError('llama.cpp chat', response);
    }

    let payload: LlamaCppChatCompletion;
    try {
      payload = await response.json() as LlamaCppChatCompletion;
    } catch (err: unknown) {
      throw new ProviderError(
        `llama.cpp chat returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    const choice = payload.choices?.[0];
    const message = choice?.message ?? {};
    const reasoningText = extractMessageText(message.reasoning_content) ?? extractMessageText(message.reasoning) ?? '';
    let responseText = extractMessageText(message.content) ?? '';
    let structuredToolCalls = normalizeOpenAIToolCalls(message.tool_calls);
    let finalToolCalls = structuredToolCalls.length > 0 ? fromOpenAIToolCalls(structuredToolCalls) : [];

    if (reasoningText) {
      params.onDelta?.({ reasoning: reasoningText });
    }

    if (structuredToolCalls.length > 0) {
      emitToolCallDeltas(structuredToolCalls, params);
    }

    if (finalToolCalls.length === 0 && (responseText.includes('<|toolcallbegin|>') || responseText.includes('<|tool_call_begin|>'))) {
      const extracted = extractTextToolCalls(responseText);
      if (extracted.toolCalls.length > 0) {
        finalToolCalls = extracted.toolCalls;
        responseText = extracted.cleanedContent;
        emitToolCallDeltas(
          finalToolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
          params,
        );
      }
    }

    if (responseText) {
      params.onDelta?.({ content: responseText });
    }

    const stopReason: ChatResponse['stopReason'] = finalToolCalls.length > 0 || choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : (choice?.finish_reason === 'length' ? 'max_tokens' : 'end');

    return {
      content: responseText,
      toolCalls: finalToolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        ...(typeof payload.usage?.prompt_tokens_details?.cached_tokens === 'number'
          ? { cacheReadTokens: payload.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
      stopReason,
    };
  }
}

function shouldUseNonStreamingLlamaCpp(params: ChatRequest): boolean {
  if ((params.tools?.length ?? 0) > 0) return true;
  return params.messages.some((message) => (
    message.role === 'tool'
    || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
  ));
}

function deriveLlamaCppChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function buildReasoningBody(
  reasoningFormat: OpenAICompatOptions['reasoningFormat'],
  reasoningEffort: ChatRequest['reasoningEffort'],
): Record<string, unknown> {
  if (reasoningFormat === 'llamacpp') {
    return {
      enable_thinking: reasoningEffort !== undefined && reasoningEffort !== 'instant',
    };
  }
  if (reasoningFormat === 'openrouter' && reasoningEffort) {
    return { reasoning: { effort: reasoningEffort } };
  }
  if (reasoningFormat === 'mercury' && reasoningEffort) {
    return { reasoning_effort: reasoningEffort };
  }
  return {};
}

function buildHeaders(
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(defaultHeaders ?? {}),
  };
}

function extractMessageText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const text = record.text ?? record.content ?? record.delta;
    if (typeof text === 'string' && text.length > 0) {
      fragments.push(text);
    }
  }
  return fragments.length > 0 ? fragments.join('') : null;
}

function normalizeOpenAIToolCalls(value: unknown): OpenAIToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== 'object') return [];
    const functionRecord = fn as Record<string, unknown>;
    const name = typeof functionRecord.name === 'string' ? functionRecord.name : '';
    if (!name) return [];
    const rawArguments = functionRecord.arguments;
    const argumentsText = typeof rawArguments === 'string'
      ? rawArguments
      : JSON.stringify(rawArguments ?? {});
    return [{
      id: typeof record.id === 'string' && record.id.length > 0 ? record.id : `llamacpp_call_${index}`,
      type: 'function' as const,
      function: {
        name,
        arguments: argumentsText,
      },
    }];
  });
}

function emitToolCallDeltas(
  toolCalls: OpenAIToolCall[],
  params: ChatRequest,
): void {
  toolCalls.forEach((toolCall, index) => {
    const partial: PartialToolCall = {
      index,
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    };
    params.onDelta?.({ toolCalls: [partial] });
  });
}

async function buildHttpError(prefix: string, response: Response): Promise<ProviderError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = toRecord(parsed.error);
    if (Object.keys(error).length > 0) {
      const code = typeof error.code === 'string' ? `${error.code}: ` : '';
      const message = typeof error.message === 'string' ? error.message : text;
      return new ProviderError(`${prefix} error ${response.status}: ${code}${message}`, response.status);
    }
  } catch {
    // fall through
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, response.status);
}

function normalizeProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(getErrorMessage(err), getErrorStatus(err));
}

function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const record = err as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.statusCode === 'number') return record.statusCode;
  }
  return undefined;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
