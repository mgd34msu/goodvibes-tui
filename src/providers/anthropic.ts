import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { REASONING_BUDGET_MAP } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import { logger } from '../utils/logger.ts';
import {
  toAnthropicTools,
  toAnthropicMessages,
  fromAnthropicContent,
} from './tool-formats.ts';
import type { AnthropicContentBlock } from './tool-formats.ts';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';

interface AnthropicResponseBody {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** Anthropic SSE event types used in streaming responses. */
interface AnthropicSSEEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
  };
  message?: {
    usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** Anthropic model-specific max output token caps. */
const ANTHROPIC_MAX_OUTPUT: Array<{ match: (m: string) => boolean; cap: number }> = [
  { match: (m) => m.startsWith('claude-opus-4-6') || m.startsWith('claude-sonnet-4-6'), cap: 128000 },
  { match: (m) => m.includes('opus-4-5') || m.includes('sonnet-4-5') || m.includes('sonnet-4-0') || m.includes('sonnet-4'), cap: 64000 },
  { match: (m) => m.includes('opus-4'), cap: 32000 },
  { match: (m) => m.includes('haiku'), cap: 8192 },
];
const ANTHROPIC_DEFAULT_MAX_OUTPUT = 16384;

/** Clamp max_tokens to the model's known limit. */
function clampMaxTokens(model: string, requested: number): number {
  for (const { match, cap } of ANTHROPIC_MAX_OUTPUT) {
    if (match(model)) return Math.min(requested, cap);
  }
  return Math.min(requested, ANTHROPIC_DEFAULT_MAX_OUTPUT);
}

/**
 * AnthropicProvider — calls the Anthropic Messages API directly via fetch.
 * System message is a top-level field (not a message). Tool results are
 * `tool_result` content blocks inside `user` messages.
 * Supports SSE streaming when onDelta is provided.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly models = [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort } = params;

    return withRetry(async () => {
      const body: Record<string, unknown> = {
        model,
        max_tokens: clampMaxTokens(model, maxTokens ?? 8192),
        messages: toAnthropicMessages(messages),
        stream: true,
      };

      if (systemPrompt) {
        // Use cache_control to enable Anthropic prompt caching on the system prompt.
        // Everything up to the last cache_control breakpoint is cached across requests.
        body['system'] = [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ];
      }

      if (tools && tools.length > 0) {
        const anthropicTools = toAnthropicTools(tools);
        // Mark the last tool with cache_control so the full tool set is cached
        if (anthropicTools.length > 0) {
          const lastTool = anthropicTools[anthropicTools.length - 1] as unknown as Record<string, unknown>;
          lastTool['cache_control'] = { type: 'ephemeral' };
        }
        body['tools'] = anthropicTools;
      }

      if (reasoningEffort && reasoningEffort !== 'instant') {
        const budget = REASONING_BUDGET_MAP[reasoningEffort];
        if (budget !== undefined && budget > 0) {
          body['thinking'] = { type: 'enabled', budget_tokens: budget };
          // max_tokens must be strictly greater than thinking.budget_tokens
          const currentMax = (body['max_tokens'] as number) ?? 8192;
          if (currentMax <= budget) {
            body['max_tokens'] = budget + 4096;
          }
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      };
      if (body['thinking']) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
      }

      let res: Response;
      try {
        res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err: unknown) {
        throw new ProviderError(
          err instanceof Error ? err.message : String(err),
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new ProviderError(`Anthropic API error ${res.status}: ${text}`, res.status);
      }

      // Parse SSE stream
      let responseText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let stopReason: ChatResponse['stopReason'] = 'end';

      // Accumulate tool use blocks by index
      const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

      const reader = res.body?.getReader();
      if (!reader) throw new ProviderError('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last (potentially incomplete) line in buffer
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let event: AnthropicSSEEvent;
            try {
              event = JSON.parse(data) as AnthropicSSEEvent;
            } catch {
              logger.debug('Anthropic SSE: failed to parse JSON chunk', { data });
              continue;
            }

            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              const idx = event.index ?? 0;
              toolBlocks.set(idx, {
                id: event.content_block.id ?? '',
                name: event.content_block.name ?? '',
                args: '',
              });
              if (onDelta) {
                onDelta({ toolCalls: [{ index: idx, id: event.content_block.id, name: event.content_block.name }] });
              }
            } else if (event.type === 'content_block_delta') {
              const idx = event.index ?? 0;
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                responseText += event.delta.text;
                if (onDelta) onDelta({ content: event.delta.text });
              } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                if (onDelta) onDelta({ reasoning: event.delta.thinking });
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                const block = toolBlocks.get(idx);
                if (block) block.args += event.delta.partial_json;
                if (onDelta) {
                  onDelta({ toolCalls: [{ index: idx, arguments: event.delta.partial_json }] });
                }
              }
            } else if (event.type === 'message_delta') {
              if (event.delta?.stop_reason === 'tool_use') stopReason = 'tool_use';
              else if (event.delta?.stop_reason === 'max_tokens') stopReason = 'max_tokens';
              if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
              if (event.usage?.cache_read_input_tokens != null) cacheReadTokens = event.usage.cache_read_input_tokens;
              if (event.usage?.cache_creation_input_tokens != null) cacheWriteTokens = event.usage.cache_creation_input_tokens;
            } else if (event.type === 'message_start') {
              if (event.message?.usage) {
                inputTokens = event.message.usage.input_tokens;
                outputTokens = event.message.usage.output_tokens;
                cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
                cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Build the content blocks for fromAnthropicContent
      const contentBlocks: AnthropicContentBlock[] = [];
      if (responseText) {
        contentBlocks.push({ type: 'text', text: responseText } as AnthropicContentBlock);
      }
      for (const [, block] of [...toolBlocks.entries()].sort(([a], [b]) => a - b)) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(block.args || '{}') as Record<string, unknown>;
        } catch {
          logger.debug('Anthropic: failed to parse tool args JSON', { name: block.name, args: block.args });
          parsedInput = {};
        }
        contentBlocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parsedInput,
        } as AnthropicContentBlock);
      }

      const { text, toolCalls } = fromAnthropicContent(contentBlocks);

      return {
        content: text,
        toolCalls,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        stopReason,
      };
    });
  }
}
