import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.ts';
import { REASONING_BUDGET_MAP } from './interface.ts';
import { ProviderError } from '@pellux/goodvibes-sdk/platform/types/errors';
import { withRetry } from '@pellux/goodvibes-sdk/platform/utils/retry';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import {
  toAnthropicTools,
  toAnthropicMessages,
  fromAnthropicContent,
} from './tool-formats.ts';
import type { AnthropicContentBlock } from './tool-formats.ts';
import { toProviderError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

const ANTHROPIC_API_VERSION = '2023-06-01';

interface AnthropicCompatResponseBody {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** Anthropic SSE event types used in streaming responses. */
interface AnthropicCompatSSEEvent {
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

export interface AnthropicCompatOptions {
  /** Unique provider identifier, e.g. 'my-anthropic-proxy' */
  name: string;
  /** Base URL for the Anthropic Messages API, e.g. 'https://my-proxy.example.com/v1' */
  baseURL: string;
  /** API key sent as the x-api-key header */
  apiKey: string;
  /** Model ID to use when none is specified in ChatRequest */
  defaultModel: string;
  /** List of model IDs exposed by this provider */
  models: string[];
  /** Optional extra HTTP headers sent with every request */
  defaultHeaders?: Record<string, string>;
  /** Optional env vars or secret keys that can satisfy auth for this provider. */
  authEnvVars?: readonly string[];
  /** Optional service names that expose service-owned OAuth for this provider. */
  serviceNames?: readonly string[];
  /** Optional provider aliases exposed to runtime metadata consumers. */
  aliases?: readonly string[];
  /** Optional subscription-provider identity when this provider can use a stored OAuth session. */
  subscriptionProviderId?: string;
  /** Optional explicit stream protocol label for diagnostics. */
  streamProtocol?: string;
  /** Optional auth header mode. Default: x-api-key. */
  authHeaderMode?: 'x-api-key' | 'bearer';
  /** Optional anonymous/local access posture. */
  allowAnonymous?: boolean;
  anonymousConfigured?: boolean;
  anonymousDetail?: string;
}

/**
 * AnthropicCompatProvider — generic provider for endpoints that speak the
 * Anthropic Messages API (SSE streaming variant). Useful for self-hosted
 * proxies, Claude-compatible services, and any backend that mirrors the
 * Anthropic Messages API spec.
 *
 * Configured via a custom provider JSON file with `"type": "anthropic-compat"`
 * in ~/.goodvibes/tui/providers/.
 */
export class AnthropicCompatProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];

  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;
  private defaultHeaders: Record<string, string>;
  private readonly authEnvVars: readonly string[];
  private readonly serviceNames: readonly string[];
  private readonly aliases: readonly string[];
  private readonly subscriptionProviderId?: string;
  private readonly streamProtocol?: string;
  private readonly authHeaderMode: 'x-api-key' | 'bearer';
  private readonly allowAnonymous: boolean;
  private readonly anonymousConfigured: boolean;
  private readonly anonymousDetail?: string;

  constructor(opts: AnthropicCompatOptions) {
    this.name = opts.name;
    this.models = opts.models;
    this.baseURL = opts.baseURL.replace(/\/$/, ''); // strip trailing slash
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.authEnvVars = opts.authEnvVars ?? [];
    this.serviceNames = opts.serviceNames ?? [];
    this.aliases = opts.aliases ?? [];
    this.subscriptionProviderId = opts.subscriptionProviderId;
    this.streamProtocol = opts.streamProtocol;
    this.authHeaderMode = opts.authHeaderMode ?? 'x-api-key';
    this.allowAnonymous = opts.allowAnonymous ?? false;
    this.anonymousConfigured = opts.anonymousConfigured ?? false;
    this.anonymousDetail = opts.anonymousDetail;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort } = params;

    return withRetry(async () => {
      const resolvedModel = model ?? this.defaultModel;

      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: maxTokens ?? 8192,
        messages: toAnthropicMessages(messages),
        stream: true,
      };

      if (systemPrompt) {
        body['system'] = systemPrompt;
      }

      if (tools && tools.length > 0) {
        body['tools'] = toAnthropicTools(tools);
      }

      if (reasoningEffort && reasoningEffort !== 'instant') {
        const budget = REASONING_BUDGET_MAP[reasoningEffort];
        if (budget !== undefined && budget > 0) {
          body['thinking'] = { type: 'enabled', budget_tokens: budget };
          const currentMax = (body['max_tokens'] as number) ?? 8192;
          if (currentMax <= budget) {
            body['max_tokens'] = budget + 4096;
          }
        }
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_API_VERSION,
        ...this.defaultHeaders,
      };
      if (this.apiKey) {
        if (this.authHeaderMode === 'bearer') {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        } else {
          headers['x-api-key'] = this.apiKey;
        }
      }

      if (body['thinking']) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
      }

      let res: Response;
      try {
        res = await fetch(`${this.baseURL}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err: unknown) {
        throw toProviderError(err, {
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new ProviderError(
          `AnthropicCompat(${this.name}) API error ${res.status}: ${text}`,
          {
            statusCode: res.status,
            provider: this.name,
            operation: 'chat',
            phase: 'request',
          },
        );
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
      if (!reader) {
        throw new ProviderError(`AnthropicCompat(${this.name}) returned no response body.`, {
          statusCode: 502,
          provider: this.name,
          operation: 'chat',
          phase: 'response',
        });
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let event: AnthropicCompatSSEEvent;
            try {
              event = JSON.parse(data) as AnthropicCompatSSEEvent;
            } catch {
              logger.debug('AnthropicCompat SSE: failed to parse JSON chunk', { data });
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

      // Assemble content blocks
      const contentBlocks: AnthropicContentBlock[] = [];
      if (responseText) {
        contentBlocks.push({ type: 'text', text: responseText } as AnthropicContentBlock);
      }
      for (const [, block] of [...toolBlocks.entries()].sort(([a], [b]) => a - b)) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(block.args || '{}') as Record<string, unknown>;
        } catch {
          logger.debug('AnthropicCompat: failed to parse tool args JSON', { name: block.name, args: block.args });
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
        mode: this.allowAnonymous && !this.apiKey ? 'anonymous' : 'api-key',
        configured: Boolean(this.apiKey) || this.anonymousConfigured,
        detail: this.apiKey
          ? `API key for ${this.name} is available`
          : this.allowAnonymous
            ? (this.anonymousDetail ?? `${this.name} can be used without a stored API key`)
            : `API key for ${this.name} is not configured`,
        ...(this.authEnvVars.length > 0 ? { envVars: this.authEnvVars } : {}),
        routes: authRoutes,
      },
      models: {
        defaultModel: this.defaultModel,
        models: this.models,
        ...(this.aliases.length > 0 ? { aliases: this.aliases } : {}),
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: true,
        notes: ['Anthropic prompt caching and thinking controls are surfaced through the compat wrapper.'],
      },
      policy: {
        local: false,
        streamProtocol: this.streamProtocol ?? 'anthropic-sse',
        reasoningMode: 'thinking_budget',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'anthropic-prompt-cache',
      },
    };
  }
}
