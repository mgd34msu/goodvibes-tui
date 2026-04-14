import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages';
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
  ProviderRuntimeMetadata,
  ProviderRuntimeMetadataDeps,
} from './interface.ts';
import { REASONING_BUDGET_MAP } from './interface.ts';
import type { AnthropicContentBlock } from './tool-formats.ts';
import {
  fromAnthropicContent,
  toAnthropicMessages,
  toAnthropicTools,
} from './tool-formats.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import { buildStandardProviderAuthRoutes } from './runtime-metadata.ts';
import { toProviderError } from '../utils/error-display.ts';

const DEFAULT_MAX_OUTPUT = 8192;

type AnthropicStreamCapableClient = {
  messages: {
    stream: unknown;
  };
};

type AnthropicMessageStream = AsyncIterable<MessageStreamEvent> & {
  finalMessage(): Promise<{
    content: unknown;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
  }>;
};

function normalizeAnthropicModel(model: string): string {
  if (model.startsWith('anthropic:')) return model.slice('anthropic:'.length);
  if (model.startsWith('anthropic/')) return model.slice('anthropic/'.length);
  return model;
}

export interface AnthropicSdkProviderAuthConfig {
  readonly mode: 'api-key' | 'anonymous';
  readonly configured: boolean;
  readonly detail: string;
  readonly envVars?: readonly string[];
  readonly secretKeys?: readonly string[];
  readonly serviceNames?: readonly string[];
  readonly allowAnonymous?: boolean;
  readonly anonymousConfigured?: boolean;
  readonly anonymousDetail?: string;
}

export interface AnthropicSdkProviderOptions {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  readonly createClient: () => AnthropicStreamCapableClient;
  readonly auth: AnthropicSdkProviderAuthConfig;
  readonly streamProtocol: string;
  readonly notes?: readonly string[];
}

export class AnthropicSdkProvider implements LLMProvider {
  readonly name: string;
  readonly models: string[];

  constructor(private readonly options: AnthropicSdkProviderOptions) {
    this.name = options.name;
    this.models = [...options.models];
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    return withRetry(async () => {
      const client = this.options.createClient();
      const resolvedModel = normalizeAnthropicModel(params.model ?? this.options.defaultModel);
      const body: Record<string, unknown> = {
        model: resolvedModel,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_OUTPUT,
        messages: toAnthropicMessages(params.messages),
        stream: true,
      };

      if (params.systemPrompt) {
        body['system'] = params.systemPrompt;
      }

      if (params.tools && params.tools.length > 0) {
        body['tools'] = toAnthropicTools(params.tools);
      }

      if (params.reasoningEffort && params.reasoningEffort !== 'instant') {
        const budget = REASONING_BUDGET_MAP[params.reasoningEffort];
        if (typeof budget === 'number' && budget > 0) {
          body['thinking'] = { type: 'enabled', budget_tokens: budget };
          const currentMax = (body['max_tokens'] as number) ?? DEFAULT_MAX_OUTPUT;
          if (currentMax <= budget) body['max_tokens'] = budget + 4096;
        }
      }

      const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
      let responseText = '';
      let stopReason: ChatResponse['stopReason'] = 'end';

      try {
        const streamFactory = client.messages.stream as (
          body: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => AnthropicMessageStream;
        const stream = streamFactory(body, params.signal ? { signal: params.signal } : undefined);
        for await (const event of stream as AsyncIterable<MessageStreamEvent>) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            const idx = event.index ?? 0;
            toolBlocks.set(idx, {
              id: event.content_block.id ?? '',
              name: event.content_block.name ?? '',
              args: '',
            });
            params.onDelta?.({
              toolCalls: [{ index: idx, id: event.content_block.id, name: event.content_block.name }],
            });
          } else if (event.type === 'content_block_delta') {
            const idx = event.index ?? 0;
            if (event.delta.type === 'text_delta' && event.delta.text) {
              responseText += event.delta.text;
              params.onDelta?.({ content: event.delta.text });
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              params.onDelta?.({ reasoning: event.delta.thinking });
            } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
              const block = toolBlocks.get(idx);
              if (block) block.args += event.delta.partial_json;
              params.onDelta?.({
                toolCalls: [{ index: idx, arguments: event.delta.partial_json }],
              });
            }
          } else if (event.type === 'message_delta') {
            if (event.delta.stop_reason === 'tool_use') stopReason = 'tool_use';
            else if (event.delta.stop_reason === 'max_tokens') stopReason = 'max_tokens';
          }
        }

        const finalMessage = await stream.finalMessage();
        const contentBlocks: AnthropicContentBlock[] = [];
        if (responseText) {
          contentBlocks.push({ type: 'text', text: responseText } as AnthropicContentBlock);
        }
        for (const [, block] of [...toolBlocks.entries()].sort(([a], [b]) => a - b)) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(block.args || '{}') as Record<string, unknown>;
          } catch {
            parsedInput = {};
          }
          contentBlocks.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: parsedInput,
          } as AnthropicContentBlock);
        }

        const parsed = contentBlocks.length > 0
          ? fromAnthropicContent(contentBlocks)
          : fromAnthropicContent(finalMessage.content as AnthropicContentBlock[]);

        return {
          content: parsed.text,
          toolCalls: parsed.toolCalls,
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            ...(finalMessage.usage.cache_read_input_tokens != null ? { cacheReadTokens: finalMessage.usage.cache_read_input_tokens } : {}),
            ...(finalMessage.usage.cache_creation_input_tokens != null ? { cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens } : {}),
          },
          stopReason,
        };
      } catch (error) {
        throw toProviderError(error, {
          provider: this.name,
          operation: 'chat',
          phase: 'stream',
        });
      }
    });
  }

  async describeRuntime(deps: ProviderRuntimeMetadataDeps): Promise<ProviderRuntimeMetadata> {
    const authRoutes = await buildStandardProviderAuthRoutes({
      providerId: this.options.name,
      apiKeyEnvVars: this.options.auth.envVars,
      secretKeys: this.options.auth.secretKeys,
      serviceNames: this.options.auth.serviceNames,
      allowAnonymous: this.options.auth.allowAnonymous,
      anonymousConfigured: this.options.auth.anonymousConfigured,
      anonymousDetail: this.options.auth.anonymousDetail,
    }, deps);
    return {
      auth: {
        mode: this.options.auth.mode,
        configured: this.options.auth.configured,
        detail: this.options.auth.detail,
        ...(this.options.auth.envVars ? { envVars: this.options.auth.envVars } : {}),
        routes: authRoutes,
      },
      models: {
        defaultModel: this.options.defaultModel,
        models: this.models,
      },
      usage: {
        streaming: true,
        toolCalling: true,
        parallelTools: true,
        promptCaching: true,
        ...(this.options.notes ? { notes: this.options.notes } : {}),
      },
      policy: {
        local: false,
        streamProtocol: this.options.streamProtocol,
        reasoningMode: 'thinking_budget',
        supportedReasoningEfforts: ['instant', 'low', 'medium', 'high'],
      },
    };
  }
}
