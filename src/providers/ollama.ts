import { withRetry } from '../utils/retry.ts';
import { ProviderError } from '../types/errors.ts';
import type { ToolCall, ToolDefinition } from '../types/tools.ts';
import type { ProviderCapability } from './capabilities.ts';
import type { ChatRequest, ChatResponse, ContentPart, LLMProvider, PartialToolCall, ProviderMessage } from './interface.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.ts';
import { toOpenAITools } from './tool-formats.ts';

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

  private readonly defaultModel: string;
  private readonly nativeChatUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly fallbackProvider: LLMProvider;

  constructor(opts: OllamaProviderOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.nativeChatUrl = deriveOllamaChatUrl(opts.baseURL);
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
            throw normalizeProviderError(err);
          }
        }
      }

      return this.fallbackProvider.chat(params);
    });
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
      throw normalizeProviderError(err);
    }

    if (!response.ok) {
      throw await buildHttpError('Ollama native chat', response);
    }
    if (!response.body) {
      throw new ProviderError('Ollama native chat returned no response body.', 502);
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

async function buildHttpError(prefix: string, response: Response): Promise<ProviderError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = toRecord(parsed['error']);
    if (Object.keys(error).length > 0) {
      const code = typeof error['code'] === 'string' ? `${error['code']}: ` : '';
      const message = typeof error['message'] === 'string' ? error['message'] : text;
      return new ProviderError(`${prefix} error ${response.status}: ${code}${message}`, response.status);
    }
  } catch {
    // fall through
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, response.status);
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
  return err instanceof Error ? err.message : String(err);
}

function normalizeProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(getErrorMessage(err), getErrorStatus(err));
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
