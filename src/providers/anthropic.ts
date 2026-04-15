import type { LLMProvider, ChatRequest, ChatResponse, ProviderRuntimeMetadata, ProviderRuntimeMetadataDeps } from './interface.ts';
import { REASONING_BUDGET_MAP } from './interface.ts';
import { getCacheCapability } from '@pellux/goodvibes-sdk/platform/providers/cache-capability';
import { getDefaultStrategy } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
import type { CacheContext, CacheHitTracker } from '@pellux/goodvibes-sdk/platform/providers/cache-strategy';
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
const NOOP_CACHE_HIT_TRACKER: Pick<CacheHitTracker, 'getHitRate' | 'recordTurn'> = {
  getHitRate: () => 0,
  recordTurn: () => {},
};

function normalizeAnthropicModel(model: string): string {
  if (model.startsWith('anthropic:')) return model.slice('anthropic:'.length);
  if (model.startsWith('anthropic/')) return model.slice('anthropic/'.length);
  return model;
}

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
  readonly models: string[] = [];

  private readonly apiKey: string;
  private readonly cacheHitTracker: Pick<CacheHitTracker, 'getHitRate' | 'recordTurn'>;

  constructor(
    apiKey: string,
    cacheHitTracker: Pick<CacheHitTracker, 'getHitRate' | 'recordTurn'> = NOOP_CACHE_HIT_TRACKER,
  ) {
    this.apiKey = apiKey;
    this.cacheHitTracker = cacheHitTracker;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort } = params;

    return withRetry(async () => {
      const resolvedModel = normalizeAnthropicModel(model);
      // Build Anthropic-formatted messages and tools early so we can inject cache_control.
      const anthropicMessages = toAnthropicMessages(messages);
      const anthropicTools = (tools && tools.length > 0) ? toAnthropicTools(tools) : null;

      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: clampMaxTokens(resolvedModel, maxTokens ?? 8192),
        stream: true,
      };

      if (systemPrompt) {
        body['system'] = [
          { type: 'text', text: systemPrompt },
        ];
      }

      if (anthropicTools && anthropicTools.length > 0) {
        body['tools'] = anthropicTools;
      }

      // Multi-breakpoint prompt caching (up to 4 breakpoints).
      const cacheContext: CacheContext = {
        providerName: 'anthropic',
        systemPromptTokens: Math.ceil((systemPrompt?.length ?? 0) / 4),
        toolCount: tools?.length ?? 0,
        toolTokens: Math.ceil(JSON.stringify(tools ?? []).length / 4),
        conversationTurns: Math.floor(messages.length / 2),
        // Token estimates use length/4 as an approximation (actual tokenization varies by content).
        conversationTokens: Math.ceil(
          messages.reduce((sum, m) =>
            sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
        ),
        recentCacheHitRate: this.cacheHitTracker.getHitRate() || undefined,
      };

      const strategy = getDefaultStrategy(cacheContext);
      let breakpointsPlaced = 0;

      if (strategy.breakpoints.length > 0) {
        // BP1: System prompt + tools (1h TTL for stable content).
        const bp1 = strategy.breakpoints.find(b => b.position === 'system_and_tools');
        if (bp1) {
          if (anthropicTools && anthropicTools.length > 0) {
            const lastTool = anthropicTools[anthropicTools.length - 1] as unknown as Record<string, unknown>;
            lastTool['cache_control'] = bp1.ttl !== '5m'
              ? { type: 'ephemeral', ttl: bp1.ttl }
              : { type: 'ephemeral' };
            breakpointsPlaced++;
          } else if (systemPrompt) {
            const sysBlocks = body['system'] as Array<Record<string, unknown>>;
            if (sysBlocks?.length) {
              sysBlocks[sysBlocks.length - 1]['cache_control'] = bp1.ttl !== '5m'
                ? { type: 'ephemeral', ttl: bp1.ttl }
                : { type: 'ephemeral' };
              breakpointsPlaced++;
            }
          }
        }

        // BP2: Conversation history prefix — last assistant message before the final user message.
        const bp2 = strategy.breakpoints.find(b => b.position === 'conversation_prefix');
        let bp2MessageIdx = -1;
        if (bp2 && anthropicMessages.length >= 3) {
          for (let i = anthropicMessages.length - 2; i >= 0; i--) {
            const msg = anthropicMessages[i] as unknown as Record<string, unknown>;
            if (msg.role === 'assistant') {
              const content = msg.content as Array<Record<string, unknown>>;
              if (content?.length) {
                content[content.length - 1]['cache_control'] = { type: 'ephemeral' };
                bp2MessageIdx = i;
                breakpointsPlaced++;
              }
              break;
            }
          }
        }

        // BP3: Largest tool result in conversation history.
        // Skip messages within 2 indices of BP2 to avoid wasting breakpoints on overlapping prefix regions.
        const bp3 = strategy.breakpoints.find(b => b.position === 'last_tool_result');
        if (bp3) {
          let largestIdx = -1;
          let largestBlockIdx = -1;
          let largestSize = 0;
          for (let i = 0; i < anthropicMessages.length - 1; i++) {
            // Skip messages too close to BP2 to avoid proximity waste.
            if (bp2MessageIdx >= 0 && Math.abs(i - bp2MessageIdx) <= 2) continue;
            const msg = anthropicMessages[i] as unknown as Record<string, unknown>;
            if (msg.role === 'user') {
              const content = msg.content as Array<Record<string, unknown>>;
              if (content) {
                // Skip messages that already have cache_control on any content block.
                const alreadyCached = content.some(b => b['cache_control'] != null);
                if (alreadyCached) continue;
                for (let j = 0; j < content.length; j++) {
                  const block = content[j];
                  if (block['type'] === 'tool_result') {
                    const size = typeof block['content'] === 'string'
                      ? block['content'].length
                      : JSON.stringify(block['content']).length;
                    if (size > largestSize) {
                      largestSize = size;
                      largestIdx = i;
                      largestBlockIdx = j;
                    }
                  }
                }
              }
            }
          }
          // Only place BP3 if the tool result is substantial (>500 chars ~ 125 tokens).
          if (largestIdx >= 0 && largestBlockIdx >= 0 && largestSize > 500) {
            const msg = anthropicMessages[largestIdx] as unknown as Record<string, unknown>;
            const content = msg.content as Array<Record<string, unknown>>;
            // Target the specific tool_result block, not the last block in the message.
            content[largestBlockIdx]['cache_control'] = { type: 'ephemeral' };
            breakpointsPlaced++;
          }
        }
      }

      body['messages'] = anthropicMessages;

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
        'anthropic-version': ANTHROPIC_API_VERSION,
        'x-api-key': this.apiKey,
      };
      // Build beta headers: thinking and/or extended TTL prompt caching.
      const betaFeatures: string[] = [];
      if (body['thinking']) {
        betaFeatures.push('interleaved-thinking-2025-05-14');
      }
      // Extended TTL (e.g. '1h') requires the prompt-caching beta header.
      const hasExtendedTtl = strategy.breakpoints.some(bp => bp.ttl !== '5m');
      if (hasExtendedTtl) {
        betaFeatures.push('prompt-caching-2025-04-14');
      }
      if (betaFeatures.length > 0) {
        headers['anthropic-beta'] = betaFeatures.join(',');
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
        throw toProviderError(err, {
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown error');
        throw new ProviderError(formatAnthropicErrorText(res.status, text), {
          statusCode: res.status,
          provider: this.name,
          operation: 'chat',
          phase: 'request',
        });
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
        throw new ProviderError('Anthropic chat returned no response body.', {
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

      // Record cache metrics for strategy adaptation.
      this.cacheHitTracker.recordTurn({ inputTokens, cacheReadTokens, cacheWriteTokens });

      const cap = getCacheCapability('anthropic');
      // Exclude write tokens from the denominator: writes are a one-time cost and inflate the
      // apparent miss rate on the first request. Read rate = reads / (billed input + reads).
      const hitRateDenom = inputTokens + cacheReadTokens;
      const hitRate = hitRateDenom > 0 ? cacheReadTokens / hitRateDenom : undefined;

      return {
        content: text,
        toolCalls,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        stopReason,
        cacheMetrics: {
          strategy: cap.type === 'explicit' ? `explicit-${cap.maxBreakpoints}bp` : cap.type,
          breakpointsPlaced,
          hitRate,
        },
      };
    });
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const { buildStandardProviderAuthRoutes } = await import('./runtime-metadata.ts');
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: 'anthropic',
      apiKeyEnvVars: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
      serviceNames: ['anthropic'],
    }, deps);
    return {
      auth: {
        mode: 'api-key',
        configured: Boolean(this.apiKey),
        detail: this.apiKey ? 'Anthropic API key available' : 'Anthropic API key is not configured',
        envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
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
        notes: ['Anthropic prompt caching and thinking budgets are handled natively.'],
      },
      policy: {
        local: false,
        streamProtocol: 'anthropic-sse',
        reasoningMode: 'thinking_budget',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
        cacheStrategy: 'anthropic-prompt-cache',
      },
    };
  }
}

function formatAnthropicErrorText(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; type?: unknown; request_id?: unknown };
    const details = (() => {
      if (parsed.error && typeof parsed.error === 'object') return JSON.stringify(parsed.error);
      if (typeof parsed.error === 'string') return parsed.error;
      return JSON.stringify(parsed);
    })();
    const requestId = typeof parsed.request_id === 'string' ? ` (request_id=${parsed.request_id})` : '';
    return `Anthropic API error ${status}: ${details}${requestId}`;
  } catch {
    return `Anthropic API error ${status}: ${text}`;
  }
}
