import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
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

/**
 * AnthropicProvider — calls the Anthropic Messages API directly via fetch.
 * System message is a top-level field (not a message). Tool results are
 * `tool_result` content blocks inside `user` messages.
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
    const { messages, tools, model, maxTokens, signal, systemPrompt } = params;

    return withRetry(async () => {
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens ?? 8096,
        messages: toAnthropicMessages(messages),
      };

      if (systemPrompt) {
        body['system'] = systemPrompt;
      }

      if (tools && tools.length > 0) {
        body['tools'] = toAnthropicTools(tools);
      }

      let res: Response;
      try {
        res = await fetch(`${ANTHROPIC_API_BASE}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_API_VERSION,
          },
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

      const data = (await res.json()) as AnthropicResponseBody;
      const { text, toolCalls } = fromAnthropicContent(data.content);

      let stopReason: ChatResponse['stopReason'] = 'end';
      if (data.stop_reason === 'tool_use') stopReason = 'tool_use';
      else if (data.stop_reason === 'max_tokens') stopReason = 'max_tokens';

      return {
        content: text,
        toolCalls,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
        stopReason,
      };
    });
  }
}
