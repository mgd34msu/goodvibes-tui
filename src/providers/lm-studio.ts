import OpenAI from 'openai';
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
} from './interface.ts';
import type { ToolCall, ToolDefinition } from '../types/tools.ts';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';

type ResponsesInputItem =
  | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> }
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }>; status: 'completed'; id: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type NativeChatOutputItem =
  | { type: 'message'; content?: string }
  | { type: 'reasoning'; content?: string }
  | { type: 'tool_call'; tool?: string; arguments?: Record<string, unknown> }
  | { type: 'invalid_tool_call'; reason?: string };

type NativeChatResult = {
  output?: NativeChatOutputItem[];
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    total_output_tokens?: number;
  };
  response_id?: string;
};

type NativeChatContext = {
  input: string | Array<Record<string, unknown>>;
  previousResponseId?: string;
};

type LMStudioResponsesStream = AsyncIterable<unknown> & {
  finalResponse?: () => Promise<Record<string, unknown>>;
};

type LMStudioResponsesClient = {
  create(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<LMStudioResponsesStream>;
};

type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface LMStudioProviderOptions extends OpenAICompatOptions {
  nativeFetch?: NativeFetch;
  responsesClient?: LMStudioResponsesClient;
  fallbackProvider?: LLMProvider;
  capabilities?: Partial<ProviderCapability>;
}

export class LMStudioProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];
  readonly capabilities?: Partial<ProviderCapability>;

  private readonly defaultModel: string;
  private readonly nativeChatUrl: string;
  private readonly nativeFetch: NativeFetch;
  private readonly responsesClient: LMStudioResponsesClient;
  private readonly fallbackProvider: LLMProvider;
  private readonly nativeResponseIds = new Map<string, string>();

  constructor(opts: LMStudioProviderOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.capabilities = opts.capabilities;
    this.defaultModel = opts.defaultModel;
    this.nativeChatUrl = deriveNativeChatUrl(opts.baseURL);
    this.nativeFetch = opts.nativeFetch ?? ((input, init) => fetch(input, init));
    this.responsesClient = opts.responsesClient ?? createResponsesClient(opts.baseURL, opts.apiKey, opts.defaultHeaders);
    this.fallbackProvider = opts.fallbackProvider ?? new OpenAICompatProvider(opts);
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const model = params.model || this.defaultModel;
      const nativeContext = this.getNativeChatContext(model, params.systemPrompt, params.messages, params.tools);

      if (nativeContext) {
        try {
          return await this.chatViaNativeChat(params, model, nativeContext);
        } catch (err: unknown) {
          if (!shouldFallbackFromNative(err)) {
            throw normalizeProviderError(err);
          }
        }
      }

      try {
        return await this.chatViaResponses(params, model);
      } catch (err: unknown) {
        if (!shouldFallbackFromResponses(err)) {
          throw normalizeProviderError(err);
        }
      }

      return this.fallbackProvider.chat(params);
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    if (!this.fallbackProvider.embed) {
      throw new ProviderError('LM Studio fallback provider does not support embeddings.', 501);
    }
    return this.fallbackProvider.embed(request);
  }

  async describeRuntime(): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: ['LM_STUDIO_API_KEY'],
      secretKeys: ['LM_STUDIO_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPAT_API_KEY'],
      allowAnonymous: true,
      anonymousConfigured: true,
      anonymousDetail: 'LM Studio local servers can be used anonymously unless the host is configured with auth.',
    });
    return {
      auth: {
        mode: 'anonymous',
        configured: true,
        detail: 'LM Studio is treated as a local-first provider with optional API-key support.',
        envVars: ['LM_STUDIO_API_KEY'],
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
        notes: ['LM Studio prefers native chat SSE when possible and falls back to the responses or OpenAI-compatible path when needed.'],
      },
      policy: {
        local: true,
        streamProtocol: 'lmstudio-native-or-responses',
        reasoningMode: 'native-reasoning-events',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'provider-managed',
      },
    };
  }

  private getNativeChatContext(
    model: string,
    systemPrompt: string | undefined,
    messages: ProviderMessage[],
    tools: ToolDefinition[] | undefined,
  ): NativeChatContext | null {
    if ((tools?.length ?? 0) > 0) return null;
    if (messages.length === 0) return null;
    if (messages.some((message) => (
      message.role === 'tool'
      || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
    ))) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') return null;

    const previousMessages = messages.slice(0, -1);
    let previousResponseId: string | undefined;
    if (previousMessages.length > 0) {
      const previousKey = makeTranscriptKey(model, systemPrompt, previousMessages);
      previousResponseId = this.nativeResponseIds.get(previousKey);
      if (!previousResponseId) return null;
    }

    return {
      input: toNativeChatInput(lastMessage.content),
      ...(previousResponseId ? { previousResponseId } : {}),
    };
  }

  private rememberNativeResponse(
    model: string,
    systemPrompt: string | undefined,
    requestMessages: ProviderMessage[],
    assistantContent: string,
    responseId: string | undefined,
  ): void {
    if (!responseId) return;
    const key = makeTranscriptKey(model, systemPrompt, [
      ...requestMessages,
      { role: 'assistant', content: assistantContent },
    ]);
    this.nativeResponseIds.set(key, responseId);
  }

  private async chatViaNativeChat(
    params: ChatRequest,
    model: string,
    context: NativeChatContext,
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      input: context.input,
      stream: true,
      store: true,
      ...(params.systemPrompt ? { system_prompt: params.systemPrompt } : {}),
      ...(params.maxTokens ? { max_output_tokens: params.maxTokens } : {}),
      ...(mapNativeReasoningEffort(params.reasoningEffort) ? { reasoning: mapNativeReasoningEffort(params.reasoningEffort) } : {}),
      ...(context.previousResponseId ? { previous_response_id: context.previousResponseId } : {}),
    };

    let response: Response;
    try {
      response = await this.nativeFetch(this.nativeChatUrl, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err: unknown) {
      throw normalizeProviderError(err);
    }

    if (!response.ok) {
      throw await buildHttpError('LM Studio native chat', response);
    }
    if (!response.body) {
      throw new ProviderError('LM Studio native chat returned no response body.', 502);
    }

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finalResult: NativeChatResult | undefined;
    let streamedError: ProviderError | undefined;

    await consumeSSE(response.body, (eventType, payload) => {
      if (eventType === 'reasoning.delta') {
        const delta = typeof payload['content'] === 'string' ? payload['content'] : '';
        if (delta) params.onDelta?.({ reasoning: delta });
        return;
      }

      if (eventType === 'message.delta') {
        const delta = typeof payload['content'] === 'string' ? payload['content'] : '';
        if (!delta) return;
        text += delta;
        params.onDelta?.({ content: delta });
        return;
      }

      if (eventType === 'error') {
        const error = payload['error'];
        if (error && typeof error === 'object') {
          const record = error as Record<string, unknown>;
          const message = typeof record['message'] === 'string' ? record['message'] : 'Unknown LM Studio streaming error';
          const code = typeof record['code'] === 'string' ? `${record['code']}: ` : '';
          streamedError = new ProviderError(`LM Studio native chat error: ${code}${message}`, 400);
        } else {
          streamedError = new ProviderError('LM Studio native chat returned a streaming error.', 400);
        }
        return;
      }

      if (eventType === 'chat.end') {
        const result = payload['result'];
        if (!result || typeof result !== 'object') return;
        finalResult = result as NativeChatResult;
        const stats = finalResult.stats;
        inputTokens = typeof stats?.input_tokens === 'number' ? stats.input_tokens : inputTokens;
        outputTokens = typeof stats?.total_output_tokens === 'number'
          ? stats.total_output_tokens
          : (typeof stats?.output_tokens === 'number' ? stats.output_tokens : outputTokens);
      }
    });

    if (streamedError) throw streamedError;
    if (!finalResult) {
      throw new ProviderError('LM Studio native chat stream ended without a final result.', 502);
    }

    if (!text) {
      text = extractNativeMessageText(finalResult.output);
    }

    this.rememberNativeResponse(model, params.systemPrompt, params.messages, text, finalResult.response_id);

    return {
      content: text,
      toolCalls: [],
      usage: {
        inputTokens,
        outputTokens,
      },
      stopReason: 'end',
    };
  }

  private async chatViaResponses(
    params: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    const tools = buildResponsesTools(params.tools);
    const reasoning = buildResponsesReasoning(params.reasoningEffort);
    const body: Record<string, unknown> = {
      model,
      input: buildResponsesInput(params.messages),
      stream: true,
      store: false,
      ...(params.systemPrompt?.trim() ? { instructions: params.systemPrompt.trim() } : {}),
      ...(params.maxTokens ? { max_output_tokens: params.maxTokens } : {}),
      ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      ...(reasoning ? { reasoning } : {}),
    };

    let stream: LMStudioResponsesStream;
    try {
      stream = await this.responsesClient.create(body, { signal: params.signal });
    } catch (err: unknown) {
      throw normalizeProviderError(err);
    }

    let text = '';
    let reasoningSummary = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let status = 'completed';
    const toolStarts = new Map<string, PartialToolCall>();
    const toolItemIds = new Map<string, string>();
    const toolArgs = new Map<string, string>();
    const toolCalls = new Map<string, ToolCall>();

    for await (const event of stream) {
      const record = toRecord(event);
      const type = typeof record['type'] === 'string' ? record['type'] : '';

      if (type === 'response.output_item.added') {
        const item = toRecord(record['item']);
        if (item['type'] !== 'function_call') continue;
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : '';
        const itemId = typeof item['id'] === 'string' ? item['id'] : '';
        if (!callId) continue;
        const partial: PartialToolCall = {
          index: toolStarts.size,
          id: callId,
          name: typeof item['name'] === 'string' ? item['name'] : undefined,
        };
        toolStarts.set(callId, partial);
        if (itemId) toolItemIds.set(itemId, callId);
        params.onDelta?.({ toolCalls: [partial] });
        continue;
      }

      if (type === 'response.output_text.delta') {
        const delta = typeof record['delta'] === 'string' ? record['delta'] : '';
        if (!delta) continue;
        text += delta;
        params.onDelta?.({ content: delta });
        continue;
      }

      if (type === 'response.reasoning_text.delta') {
        const delta = typeof record['delta'] === 'string' ? record['delta'] : '';
        if (!delta) continue;
        params.onDelta?.({ reasoning: delta });
        continue;
      }

      if (type === 'response.reasoning_summary_text.delta') {
        const delta = typeof record['delta'] === 'string' ? record['delta'] : '';
        if (!delta) continue;
        reasoningSummary += delta;
        continue;
      }

      if (type === 'response.function_call_arguments.delta') {
        const itemId = typeof record['item_id'] === 'string' ? record['item_id'] : '';
        const delta = typeof record['delta'] === 'string' ? record['delta'] : '';
        if (!itemId || !delta) continue;
        const callId = toolItemIds.get(itemId);
        if (!callId) continue;
        const partial = toolStarts.get(callId);
        if (!partial) continue;
        toolArgs.set(callId, `${toolArgs.get(callId) ?? ''}${delta}`);
        params.onDelta?.({
          toolCalls: [{
            index: partial.index,
            id: callId,
            name: partial.name,
            arguments: delta,
          }],
        });
        continue;
      }

      if (type === 'response.output_item.done') {
        const item = toRecord(record['item']);
        if (item['type'] !== 'function_call') continue;
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : '';
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        const argumentsText = typeof item['arguments'] === 'string'
          ? item['arguments']
          : (toolArgs.get(callId) ?? '{}');
        if (!callId || !name) continue;
        toolCalls.set(callId, {
          id: callId,
          name,
          arguments: parseJsonObject(argumentsText),
        });
        continue;
      }

      if (type === 'response.completed') {
        const completed = toRecord(record['response']);
        status = typeof completed['status'] === 'string' ? completed['status'] : status;
        const usage = toRecord(completed['usage']);
        const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
        const output = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
        const inputDetails = toRecord(usage['input_tokens_details']);
        const cached = typeof inputDetails['cached_tokens'] === 'number' ? inputDetails['cached_tokens'] : 0;
        inputTokens = Math.max(0, input - cached);
        outputTokens = output;
        cacheReadTokens = cached;
        continue;
      }

      if (type === 'response.failed') {
        const failed = toRecord(record['response']);
        const error = toRecord(failed['error']);
        const code = typeof error['code'] === 'string' ? `${error['code']}: ` : '';
        const message = typeof error['message'] === 'string' ? error['message'] : 'Unknown failure';
        throw new ProviderError(`LM Studio Responses error: ${code}${message}`, 400);
      }
    }

    const resolvedToolCalls = [...toolCalls.values()];
    const response: ChatResponse = {
      content: text,
      toolCalls: resolvedToolCalls,
      usage: {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      },
      stopReason: mapResponsesStopReason(status, resolvedToolCalls),
    };

    if (reasoningSummary) {
      response.reasoningSummary = reasoningSummary;
    }

    return response;
  }
}

function createResponsesClient(
  baseURL: string,
  apiKey: string,
  defaultHeaders: Record<string, string> | undefined,
): LMStudioResponsesClient {
  const client = new OpenAI({
    apiKey,
    baseURL,
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  return {
    create: (params, options) => client.responses.create(params as never, options) as unknown as Promise<LMStudioResponsesStream>,
  };
}

function deriveNativeChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/v1/chat`;
}

function toNativeChatInput(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return content;
  return content.map((part) => (
    part.type === 'text'
      ? { type: 'message', content: part.text }
      : { type: 'image', data_url: `data:${part.mediaType};base64,${part.data}` }
  ));
}

function buildResponsesTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function buildResponsesInput(messages: ProviderMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  let assistantIndex = 0;

  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        input.push({
          role: 'user',
          content: message.content.map((part) => (
            part.type === 'text'
              ? { type: 'input_text', text: part.text }
              : { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: 'auto' }
          )),
        });
      } else {
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: message.content }],
        });
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content, annotations: [] }],
          status: 'completed',
          id: `msg_${assistantIndex++}`,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          id: `fc_${toolCall.id}`,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        });
      }
      continue;
    }

    input.push({
      type: 'function_call_output',
      call_id: message.callId,
      output: message.content,
    });
  }

  return input;
}

function buildResponsesReasoning(
  reasoningEffort: ChatRequest['reasoningEffort'],
): Record<string, unknown> | undefined {
  if (!reasoningEffort || reasoningEffort === 'instant') return undefined;
  return { effort: reasoningEffort, summary: 'auto' };
}

function mapNativeReasoningEffort(
  reasoningEffort: ChatRequest['reasoningEffort'],
): 'off' | 'low' | 'medium' | 'high' | undefined {
  switch (reasoningEffort) {
    case 'instant':
      return 'off';
    case 'low':
    case 'medium':
    case 'high':
      return reasoningEffort;
    default:
      return undefined;
  }
}

function mapResponsesStopReason(
  status: string | undefined,
  toolCalls: ToolCall[],
): ChatResponse['stopReason'] {
  if (toolCalls.length > 0 && status === 'completed') return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'end';
}

function extractNativeMessageText(output: NativeChatOutputItem[] | undefined): string {
  if (!Array.isArray(output)) return '';
  return output
    .filter((item): item is Extract<NativeChatOutputItem, { type: 'message' }> => item.type === 'message')
    .map((item) => item.content ?? '')
    .join('');
}

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventType: string, payload: Record<string, unknown>) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData: string[] = [];

  const flush = (): void => {
    if (!currentEvent || currentData.length === 0) {
      currentEvent = '';
      currentData = [];
      return;
    }
    const rawPayload = currentData.join('\n').trim();
    currentEvent = currentEvent.trim();
    currentData = [];
    if (!rawPayload || rawPayload === '[DONE]') {
      currentEvent = '';
      return;
    }
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    const eventType = currentEvent;
    currentEvent = '';
    onEvent(eventType, payload);
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) {
        flush();
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        currentData.push(line.slice('data:'.length).trim());
      }
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      if (!line) {
        flush();
        continue;
      }
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        currentData.push(line.slice('data:'.length).trim());
      }
    }
  }
  flush();
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
    // fall through to raw body
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, response.status);
}

function makeTranscriptKey(
  model: string,
  systemPrompt: string | undefined,
  messages: ProviderMessage[],
): string {
  return stableStringify({
    model,
    ...(systemPrompt ? { systemPrompt } : {}),
    messages,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed arguments
  }
  return {};
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function shouldFallbackFromNative(err: unknown): boolean {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err);
  if (status === 404 || status === 405 || status === 501) return true;
  if (status === 400 && /previous_response_id|response_id/i.test(message)) return true;
  return /not implemented|unsupported|unknown endpoint/i.test(message);
}

function shouldFallbackFromResponses(err: unknown): boolean {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err);
  if (status === 404 || status === 405 || status === 501) return true;
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
  const status = getErrorStatus(err);
  return new ProviderError(getErrorMessage(err), status);
}
