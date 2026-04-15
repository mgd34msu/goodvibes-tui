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
  ProviderRuntimeMetadataDeps,
} from './interface.ts';
import type { ToolCall, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types/tools';
import { OpenAICompatProvider, type OpenAICompatOptions } from './openai-compat.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { withRetry } from '@pellux/goodvibes-sdk/platform/utils/retry';
import {
  buildHttpError,
  buildResponsesInput,
  buildResponsesReasoning,
  buildResponsesTools,
  consumeSSE,
  createResponsesClient,
  deriveNativeChatUrl,
  extractNativeMessageText,
  type LMStudioResponsesClient,
  type LMStudioResponsesStream,
  makeTranscriptKey,
  mapNativeReasoningEffort,
  mapResponsesStopReason,
  type NativeChatContext,
  type NativeChatResult,
  type NativeFetch,
  normalizeProviderError,
  parseJsonObject,
  shouldFallbackFromNative,
  shouldFallbackFromResponses,
  toNativeChatInput,
  toRecord,
} from './lm-studio-helpers.ts';

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
            throw normalizeProviderError(err, this.name, 'chat', 'request');
          }
        }
      }

      try {
        return await this.chatViaResponses(params, model);
      } catch (err: unknown) {
        if (!shouldFallbackFromResponses(err)) {
          throw normalizeProviderError(err, this.name, 'chat', 'request');
        }
      }

      return this.fallbackProvider.chat(params);
    });
  }

  async embed(request: ProviderEmbeddingRequest): Promise<ProviderEmbeddingResult> {
    if (!this.fallbackProvider.embed) {
      throw new ProviderError('LM Studio fallback provider does not support embeddings.', {
        statusCode: 501,
        provider: this.name,
        operation: 'embed',
        phase: 'response',
      });
    }
    return this.fallbackProvider.embed(request);
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      apiKeyEnvVars: ['LM_STUDIO_API_KEY'],
      secretKeys: ['LM_STUDIO_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPAT_API_KEY'],
      allowAnonymous: true,
      anonymousConfigured: true,
      anonymousDetail: 'LM Studio local servers can be used anonymously unless the host is configured with auth.',
    }, deps);
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
      throw normalizeProviderError(err, this.name, 'chat', 'request');
    }

    if (!response.ok) {
      throw await buildHttpError('LM Studio native chat', response, this.name, 'chat', 'request');
    }
    if (!response.body) {
      throw new ProviderError('LM Studio native chat returned no response body.', {
        statusCode: 502,
        provider: this.name,
        operation: 'chat',
        phase: 'response',
      });
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
          streamedError = new ProviderError(`LM Studio native chat error: ${code}${message}`, {
            statusCode: 400,
            provider: this.name,
            operation: 'chat',
            phase: 'stream',
          });
        } else {
          streamedError = new ProviderError('LM Studio native chat returned a streaming error.', {
            statusCode: 400,
            provider: this.name,
            operation: 'chat',
            phase: 'stream',
          });
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
      throw new ProviderError('LM Studio native chat stream ended without a final result.', {
        statusCode: 502,
        provider: this.name,
        operation: 'chat',
        phase: 'stream',
      });
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
      throw normalizeProviderError(err, this.name, 'chat', 'request');
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
        throw new ProviderError(`LM Studio Responses error: ${code}${message}`, {
          statusCode: 400,
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
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
