import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMProvider, SendMessageParams, StreamingResponse } from './provider.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';

/**
 * InceptionProvider - OpenAI-compatible provider for InceptionLabs.
 */
export class InceptionProvider implements LLMProvider {
  private client: OpenAI;
  private modelId: string;

  constructor(apiKey: string, modelId: string = 'mercury-2') {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.inceptionlabs.ai/v1',
    });
    this.modelId = modelId;
  }

  async sendMessage(params: SendMessageParams): Promise<StreamingResponse> {
    const { messages, onText, signal } = params;

    return withRetry(async () => {
      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;

      let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
      try {
        stream = await this.client.chat.completions.create({
          model: this.modelId,
          messages: messages as ChatCompletionMessageParam[],
          stream: true,
        }, { signal });
      } catch (err: unknown) {
        const statusCode = (err as { status?: number }).status;
        throw new ProviderError(
          err instanceof Error ? err.message : String(err),
          typeof statusCode === 'number' ? statusCode : undefined
        );
      }

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content || '';
          if (delta) {
            fullContent += delta;
            onText?.(delta);
          }

          const chunkUsage = (chunk as OpenAI.Chat.ChatCompletionChunk & { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
          if (chunkUsage) {
            inputTokens = chunkUsage.prompt_tokens || 0;
            outputTokens = chunkUsage.completion_tokens || 0;
          }
        }
      } catch (err: unknown) {
        const statusCode = (err as { status?: number }).status;
        throw new ProviderError(
          err instanceof Error ? err.message : String(err),
          typeof statusCode === 'number' ? statusCode : undefined
        );
      }

      return {
        content: fullContent,
        usage: { inputTokens, outputTokens },
      };
    });
  }
}
