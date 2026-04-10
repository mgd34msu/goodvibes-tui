import type { ChatRequest, ChatResponse, LLMProvider, PartialToolCall, ProviderMessage, ProviderRuntimeMetadata } from './interface.ts';
import type { ToolCall, ToolDefinition } from '../types/tools.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import { resolveSubscriptionAccessToken } from '../config/subscription-auth.ts';
import { arch, platform, release } from 'node:os';

const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

function getOpenAICodexUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

function normalizeOpenAIModel(model: string): string {
  if (model.startsWith('openai:')) return model.slice('openai:'.length);
  if (model.startsWith('openai/')) return model.slice('openai/'.length);
  return model;
}

type ResponsesInputItem =
  | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> }
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }>; status: 'completed'; id: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

function extractAccountId(accessToken: string): string {
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    throw new ProviderError('OpenAI subscription token is not a JWT.', 401);
  }
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>;
  const auth = payload['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object') {
    throw new ProviderError('OpenAI subscription token does not include account metadata.', 401);
  }
  const accountId = (auth as Record<string, unknown>)['chatgpt_account_id'];
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new ProviderError('OpenAI subscription token does not include a ChatGPT account id.', 401);
  }
  return accountId;
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

function mapStopReason(status: string | undefined, toolCalls: ToolCall[]): ChatResponse['stopReason'] {
  if (toolCalls.length > 0 && status === 'completed') return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'end';
}

function buildErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed['error'];
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const code = typeof record['code'] === 'string' ? `${record['code']}: ` : '';
      const message = typeof record['message'] === 'string' ? record['message'] : body;
      return `OpenAI Codex API error ${status}: ${code}${message}`;
    }
  } catch {
    // fall through
  }
  return `OpenAI Codex API error ${status}: ${body}`;
}

export async function chatWithOpenAICodex(
  accessToken: string,
  params: ChatRequest,
): Promise<ChatResponse> {
  return withRetry(async () => {
      const accountId = extractAccountId(accessToken);
      const sessionId = crypto.randomUUID();
      const instructions = params.systemPrompt?.trim() || 'You are a helpful assistant.';
      const model = normalizeOpenAIModel(params.model);
      const body = {
        model,
        store: false,
        stream: true,
        instructions,
        input: buildResponsesInput(params.messages),
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: sessionId,
        tool_choice: 'auto',
        parallel_tool_calls: true,
        ...(buildResponsesTools(params.tools) ? { tools: buildResponsesTools(params.tools) } : {}),
        ...(params.reasoningEffort && params.reasoningEffort !== 'instant'
          ? { reasoning: { effort: params.reasoningEffort, summary: 'auto' } }
          : {}),
      };

      const response = await fetch(`${OPENAI_CODEX_BASE_URL}/codex/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          originator: 'pi',
          'OpenAI-Beta': 'responses=experimental',
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'User-Agent': getOpenAICodexUserAgent(),
          session_id: sessionId,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new ProviderError(buildErrorMessage(response.status, errorBody), response.status);
      }
      if (!response.body) {
        throw new ProviderError('OpenAI Codex API returned no response body.', 502);
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      const toolStarts = new Map<string, PartialToolCall>();
      const toolItemIds = new Map<string, string>();
      const toolArgs = new Map<string, string>();
      const toolCalls = new Map<string, ToolCall>();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let status = 'completed';

      const handleDataPayload = (payload: string): void => {
        const fragments = payload
          .split(/\r?\ndata:\s+/)
          .map((fragment) => fragment.trim())
          .filter((fragment) => fragment.length > 0 && fragment !== '[DONE]');
        for (const fragment of fragments) {
          handleEvent(JSON.parse(fragment) as Record<string, unknown>);
        }
      };

      const handleEvent = (event: Record<string, unknown>): void => {
        const type = typeof event['type'] === 'string' ? event['type'] : '';
        if (type === 'response.output_item.added') {
          const item = event['item'];
          if (item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'function_call') {
            const record = item as Record<string, unknown>;
            const callId = typeof record['call_id'] === 'string' ? record['call_id'] : '';
            const itemId = typeof record['id'] === 'string' ? record['id'] : '';
            if (!callId) return;
            const partial: PartialToolCall = {
              index: toolStarts.size,
              id: callId,
              name: typeof record['name'] === 'string' ? record['name'] : undefined,
            };
            toolStarts.set(callId, partial);
            if (itemId) toolItemIds.set(itemId, callId);
            params.onDelta?.({ toolCalls: [partial] });
          }
          return;
        }

        if (type === 'response.output_text.delta') {
          const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
          if (!delta) return;
          text += delta;
          params.onDelta?.({ content: delta });
          return;
        }

        if (type === 'response.function_call_arguments.delta') {
          const itemId = typeof event['item_id'] === 'string' ? event['item_id'] : '';
          const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
          if (!itemId || !delta) return;
          const callId = toolItemIds.get(itemId);
          if (!callId) return;
          const partial = toolStarts.get(callId);
          if (!partial) return;
          const next = `${toolArgs.get(callId) ?? ''}${delta}`;
          toolArgs.set(callId, next);
          params.onDelta?.({
            toolCalls: [{
              index: partial.index,
              id: callId,
              name: partial.name,
              arguments: delta,
            }],
          });
          return;
        }

        if (type === 'response.output_item.done') {
          const item = event['item'];
          if (!item || typeof item !== 'object') return;
          const record = item as Record<string, unknown>;
          if (record['type'] !== 'function_call') return;
          const callId = typeof record['call_id'] === 'string' ? record['call_id'] : '';
          const name = typeof record['name'] === 'string' ? record['name'] : '';
          const argumentsText = typeof record['arguments'] === 'string'
            ? record['arguments']
            : (toolArgs.get(callId) ?? '{}');
          if (!callId || !name) return;
          try {
            toolCalls.set(callId, {
              id: callId,
              name,
              arguments: JSON.parse(argumentsText) as Record<string, unknown>,
            });
          } catch {
            toolCalls.set(callId, {
              id: callId,
              name,
              arguments: {},
            });
          }
          return;
        }

        if (type === 'response.completed') {
          const completed = event['response'];
          if (!completed || typeof completed !== 'object') return;
          const record = completed as Record<string, unknown>;
          status = typeof record['status'] === 'string' ? record['status'] : status;
          const usage = record['usage'];
          if (usage && typeof usage === 'object') {
            const usageRecord = usage as Record<string, unknown>;
            const input = typeof usageRecord['input_tokens'] === 'number' ? usageRecord['input_tokens'] : 0;
            const output = typeof usageRecord['output_tokens'] === 'number' ? usageRecord['output_tokens'] : 0;
            const inputDetails = usageRecord['input_tokens_details'];
            const cached = inputDetails && typeof inputDetails === 'object'
              && typeof (inputDetails as Record<string, unknown>)['cached_tokens'] === 'number'
              ? (inputDetails as Record<string, unknown>)['cached_tokens'] as number
              : 0;
            inputTokens = Math.max(0, input - cached);
            outputTokens = output;
            cacheReadTokens = cached;
          }
          return;
        }

        if (type === 'response.failed') {
          const failed = event['response'];
          if (!failed || typeof failed !== 'object') return;
          const error = (failed as Record<string, unknown>)['error'];
          if (error && typeof error === 'object') {
            const record = error as Record<string, unknown>;
            const code = typeof record['code'] === 'string' ? `${record['code']}: ` : '';
            const message = typeof record['message'] === 'string' ? record['message'] : 'Unknown failure';
            throw new ProviderError(`OpenAI Codex API error: ${code}${message}`, 400);
          }
          throw new ProviderError('OpenAI Codex API returned a failed response.', 400);
        }
      };

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          handleDataPayload(data);
        }
      }

      const trailing = buffer.trim();
      if (trailing.startsWith('data: ')) {
        const data = trailing.slice(6).trim();
        if (data && data !== '[DONE]') {
          handleDataPayload(data);
        }
      }

      const resolvedToolCalls = [...toolCalls.values()];
      return {
        content: text,
        toolCalls: resolvedToolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        },
        stopReason: mapStopReason(status, resolvedToolCalls),
      };
    });
}

export class OpenAICodexProvider implements LLMProvider {
  readonly name = 'openai-subscriber';
  readonly models: string[] = [];

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const accessToken = await resolveSubscriptionAccessToken('openai');
    if (!accessToken) {
      throw new ProviderError('No active OpenAI subscription token found. Run /subscription login openai start.', 401);
    }
    return chatWithOpenAICodex(accessToken, params);
  }

  async describeRuntime(): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.name,
      subscriptionProviderId: 'openai',
    });
    return {
      auth: {
        mode: 'oauth',
        configured: authRoutes.some((route) => route.route === 'subscription-oauth' && route.configured),
        detail: 'OpenAI subscriber routing depends on a stored ChatGPT/Codex subscription session.',
        routes: authRoutes,
      },
      models: {
        models: this.models,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: true,
        notes: ['This provider uses the OpenAI subscription-backed Codex responses surface instead of a direct API key.'],
      },
      policy: {
        local: false,
        streamProtocol: 'openai-codex-responses-sse',
        reasoningMode: 'responses-reasoning',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'subscription-session-cache-key',
      },
    };
  }
}
