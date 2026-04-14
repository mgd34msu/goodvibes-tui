import { withRetry } from '../utils/retry.ts';
import { ProviderError } from '../types/errors.ts';
import type { ToolCall, ToolDefinition } from '../types/tools.ts';
import type { ProviderCapability } from './capabilities.ts';
import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  LLMProvider,
  PartialToolCall,
  ProviderEmbeddingRequest,
  ProviderEmbeddingResult,
  ProviderMessage,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.ts';
import { toOpenAITools } from './tool-formats.ts';
import { summarizeError, toProviderError } from '../utils/error-display.ts';

type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type OllamaChatChunk = {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{
      function?: {
        name?: string;
        description?: string;
        arguments?: Record<string, unknown>;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export interface OllamaProviderOptions extends OpenAICompatOptions {
  nativeFetch?: NativeFetch;
  fallbackProvider?: LLMProvider;
}

export class OllamaProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability>;

  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly nativeChatUrl: string;
  private readonly nativeEmbedUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly fallbackProvider: LLMProvider;
  private readonly embeddingModel = 'embeddinggemma';

  constructor(opts: OllamaProviderOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.baseURL = opts.baseURL;
    this.defaultModel = opts.defaultModel;
    this.nativeChatUrl = deriveOllamaChatUrl(opts.baseURL);
    this.nativeEmbedUrl = deriveOllamaEmbedUrl(opts.baseURL);
    this.nativeFetch = opts.nativeFetch ?? ((input, init) => fetch(input, init));
    this.fallbackProvider = opts.fallbackProvider ?? new OpenAICompatProvider(opts);
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const model = params.model || this.defaultModel;

      if (canUseNativeOllamaChat(params.messages)) {
        try {
          return await this.chatViaNativeOllama(params, model);
        } catch (err: unknown) {
          if (!shouldFallbackFromNative(err)) {
            throw normalizeProviderError(err, this.name, 'chat', 'request');
          }
        }
      }

      return this.fallbackProvider.chat(params);
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    try {
      const response = await this.nativeFetch(this.nativeEmbedUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model ?? this.embeddingModel,
          input: request.text,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        throw await buildHttpError('Ollama native embeddings', response, this.name, 'embed', 'request');
      }

      const body = await response.json() as { embeddings?: number[][]; embedding?: number[]; model?: string };
      const vector = body.embedding ?? body.embeddings?.[0] ?? [];
      return {
        vector: Float32Array.from(vector),
        dimensions: vector.length,
        modelId: body.model ?? request.model ?? this.embeddingModel,
        metadata: {
          usage: request.usage,
          provider: this.name,
        },
      };
    } catch (err: unknown) {
      if (this.fallbackProvider.embed) {
        return this.fallbackProvider.embed(request);
      }
      throw normalizeProviderError(err, this.name, 'embed', 'request');
    }
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const local = !/^https?:\/\/ollama\.com\b/i.test(this.baseURL);
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
      secretKeys: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
      serviceNames: ['ollama-cloud'],
      allowAnonymous: local,
      anonymousConfigured: local,
      anonymousDetail: 'Local Ollama endpoints can be used without an API key.',
    }, deps);
    return {
      auth: {
        mode: local ? 'anonymous' : 'api-key',
        configured: local || Boolean(process.env.OLLAMA_API_KEY || process.env.OLLAMA_CLOUD_API_KEY),
        detail: local
          ? 'Local Ollama endpoint does not require an API key'
          : 'Ollama Cloud API key is required',
        envVars: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
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
        parallelTools: false,
        notes: ['Native Ollama embeddings prefer the /api/embed endpoint.'],
      },
      policy: {
        local,
        streamProtocol: 'ollama-ndjson',
        reasoningMode: 'native-think-toggle',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'provider-managed',
        notes: local ? ['Local-first embedding generation.'] : ['Remote Ollama Cloud usage is subject to service policy.'],
      },
    };
  }

  private async chatViaNativeOllama(
    params: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    const messages = toOllamaMessages(params.messages, params.systemPrompt);
    const think = mapOllamaThinking(params.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(params.tools && params.tools.length > 0 ? { tools: toOpenAITools(params.tools) } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(params.maxTokens ? { options: { num_predict: params.maxTokens } } : {}),
    };

    let response: Response;
    try {
      response = await this.nativeFetch(this.nativeChatUrl, {
        method: 'POST',
        headers: {
          accept: 'application/x-ndjson, application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err: unknown) {
      throw normalizeProviderError(err, this.name, 'chat', 'request');
    }

    if (!response.ok) {
      throw await buildHttpError('Ollama native chat', response, this.name, 'chat', 'request');
    }
    if (!response.body) {
      throw new ProviderError('Ollama native chat returned no response body.', {
        statusCode: 502,
        provider: this.name,
        operation: 'chat',
        phase: 'response',
      });
    }

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let doneReason = '';
    let finalToolCalls: ToolCall[] = [];
    const emittedToolCalls = new Set<string>();

    await consumeNDJSON(response.body, (chunk) => {
      const message = chunk.message;
      const content = typeof message?.content === 'string' ? message.content : '';
      if (content) {
        responseText += content;
        params.onDelta?.({ content });
      }

      const thinking = typeof message?.thinking === 'string' ? message.thinking : '';
      if (thinking) {
        params.onDelta?.({ reasoning: thinking });
      }

      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        const normalized = normalizeOllamaToolCalls(message.tool_calls);
        finalToolCalls = normalized;
        normalized.forEach((call, index) => {
          if (emittedToolCalls.has(call.id)) return;
          emittedToolCalls.add(call.id);
          const argumentsText = JSON.stringify(call.arguments);
          const partial: PartialToolCall = {
            index,
            id: call.id,
            name: call.name,
            arguments: argumentsText,
          };
          params.onDelta?.({ toolCalls: [partial] });
        });
      }

      if (chunk.done) {
        doneReason = typeof chunk.done_reason === 'string' ? chunk.done_reason : doneReason;
        inputTokens = typeof chunk.prompt_eval_count === 'number' ? chunk.prompt_eval_count : inputTokens;
        outputTokens = typeof chunk.eval_count === 'number' ? chunk.eval_count : outputTokens;
      }
    });

    const stopReason: ChatResponse['stopReason'] = finalToolCalls.length > 0 || /tool/i.test(doneReason)
      ? 'tool_use'
      : (/length|max_tokens/i.test(doneReason) ? 'max_tokens' : 'end');

    return {
      content: responseText,
      toolCalls: finalToolCalls,
      usage: {
        inputTokens,
        outputTokens,
      },
      stopReason,
    };
  }
}

function deriveOllamaChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/chat`;
}

function deriveOllamaEmbedUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/embed`;
}

function canUseNativeOllamaChat(messages: ProviderMessage[]): boolean {
  if (messages.length === 0) return false;
  return !messages.some((message) => (
    message.role === 'tool'
    || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
  ));
}

function toOllamaMessages(
  messages: ProviderMessage[],
  systemPrompt: string | undefined,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  if (systemPrompt?.trim()) {
    result.push({ role: 'system', content: systemPrompt.trim() });
  }

  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        result.push(contentPartsToOllamaMessage('user', message.content));
      } else {
        result.push({ role: 'user', content: message.content });
      }
      continue;
    }

    if (message.role === 'assistant') {
      result.push({ role: 'assistant', content: message.content });
      continue;
    }
  }

  return result;
}

function contentPartsToOllamaMessage(
  role: 'user' | 'assistant',
  parts: ContentPart[],
): Record<string, unknown> {
  const text = parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const images = parts
    .filter((part): part is Extract<ContentPart, { type: 'image' }> => part.type === 'image')
    .map((part) => part.data);

  return {
    role,
    content: text,
    ...(images.length > 0 ? { images } : {}),
  };
}

function normalizeOllamaToolCalls(
  calls: NonNullable<NonNullable<OllamaChatChunk['message']>['tool_calls']>,
): ToolCall[] {
  return calls.flatMap((call, index) => {
    const fn = call.function;
    if (!fn || typeof fn.name !== 'string' || fn.name.length === 0) return [];
    return [{
      id: `ollama_call_${index}`,
      name: fn.name,
      arguments: fn.arguments && typeof fn.arguments === 'object' ? fn.arguments : {},
    }];
  });
}

function mapOllamaThinking(
  reasoningEffort: ChatRequest['reasoningEffort'],
): boolean | 'low' | 'medium' | 'high' | undefined {
  switch (reasoningEffort) {
    case 'instant':
      return false;
    case 'low':
    case 'medium':
    case 'high':
      return reasoningEffort;
    default:
      return undefined;
  }
}

async function consumeNDJSON(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: OllamaChatChunk) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      onChunk(JSON.parse(trimmed) as OllamaChatChunk);
    }
  }

  buffer += decoder.decode();
  const trailing = buffer.trim();
  if (trailing) {
    onChunk(JSON.parse(trailing) as OllamaChatChunk);
  }
}

async function buildHttpError(
  prefix: string,
  response: Response,
  provider: string,
  operation: string,
  phase: string,
): Promise<ProviderError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = toRecord(parsed['error']);
    if (Object.keys(error).length > 0) {
      const code = typeof error['code'] === 'string' ? `${error['code']}: ` : '';
      const message = typeof error['message'] === 'string' ? error['message'] : text;
      return new ProviderError(`${prefix} error ${response.status}: ${code}${message}`, {
        statusCode: response.status,
        provider,
        operation,
        phase,
      });
    }
  } catch {
    // fall through
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, {
    statusCode: response.status,
    provider,
    operation,
    phase,
  });
}

function shouldFallbackFromNative(err: unknown): boolean {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err);
  if (status === 404 || status === 405 || status === 501) return true;
  if (status === 400 && /tool|messages|unsupported/i.test(message)) return true;
  return /not implemented|unsupported|unknown endpoint/i.test(message);
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
  return summarizeError(err);
}

function normalizeProviderError(err: unknown, provider: string, operation: string, phase = 'request'): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
