import OpenAI from 'openai';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import type { ToolCall, ToolDefinition } from '@pellux/goodvibes-sdk/platform/types/tools';
import { summarizeError, toProviderError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  ProviderMessage,
} from './interface.ts';

export type ResponsesInputItem =
  | { role: 'user'; content: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }> }
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string; annotations: [] }>; status: 'completed'; id: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export type NativeChatOutputItem =
  | { type: 'message'; content?: string }
  | { type: 'reasoning'; content?: string }
  | { type: 'tool_call'; tool?: string; arguments?: Record<string, unknown> }
  | { type: 'invalid_tool_call'; reason?: string };

export type NativeChatResult = {
  output?: NativeChatOutputItem[];
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    total_output_tokens?: number;
  };
  response_id?: string;
};

export type NativeChatContext = {
  input: string | Array<Record<string, unknown>>;
  previousResponseId?: string;
};

export type LMStudioResponsesStream = AsyncIterable<unknown> & {
  finalResponse?: () => Promise<Record<string, unknown>>;
};

export type LMStudioResponsesClient = {
  create(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<LMStudioResponsesStream>;
};

export type NativeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createResponsesClient(
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

export function deriveNativeChatUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  const origin = trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
  return `${origin}/api/v1/chat`;
}

export function toNativeChatInput(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return content;
  return content.map((part) => (
    part.type === 'text'
      ? { type: 'message', content: part.text }
      : { type: 'image', data_url: `data:${part.mediaType};base64,${part.data}` }
  ));
}

export function buildResponsesTools(tools?: ToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export function buildResponsesInput(messages: ProviderMessage[]): ResponsesInputItem[] {
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

export function buildResponsesReasoning(
  reasoningEffort: ChatRequest['reasoningEffort'],
): Record<string, unknown> | undefined {
  if (!reasoningEffort || reasoningEffort === 'instant') return undefined;
  return { effort: reasoningEffort, summary: 'auto' };
}

export function mapNativeReasoningEffort(
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

export function mapResponsesStopReason(
  status: string | undefined,
  toolCalls: ToolCall[],
): ChatResponse['stopReason'] {
  if (toolCalls.length > 0 && status === 'completed') return 'tool_use';
  if (status === 'incomplete') return 'max_tokens';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'end';
}

export function extractNativeMessageText(output: NativeChatOutputItem[] | undefined): string {
  if (!Array.isArray(output)) return '';
  return output
    .filter((item): item is Extract<NativeChatOutputItem, { type: 'message' }> => item.type === 'message')
    .map((item) => item.content ?? '')
    .join('');
}

export async function consumeSSE(
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

  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buffer += decoder.decode(value, { stream: true });
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

export async function buildHttpError(
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
    // fall through to raw body
  }
  return new ProviderError(`${prefix} error ${response.status}: ${text || response.statusText}`, {
    statusCode: response.status,
    provider,
    operation,
    phase,
  });
}

export function makeTranscriptKey(
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

export function parseJsonObject(raw: string): Record<string, unknown> {
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

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function shouldFallbackFromNative(err: unknown): boolean {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err);
  if (status === 404 || status === 405 || status === 501) return true;
  if (status === 400 && /previous_response_id|response_id/i.test(message)) return true;
  return /not implemented|unsupported|unknown endpoint/i.test(message);
}

export function shouldFallbackFromResponses(err: unknown): boolean {
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
  return summarizeError(err);
}

export function normalizeProviderError(err: unknown, provider: string, operation: string, phase = 'request'): ProviderError {
  const status = getErrorStatus(err);
  return toProviderError(err, {
    ...(status !== undefined ? { statusCode: status } : {}),
    provider,
    operation,
    phase,
  });
}
