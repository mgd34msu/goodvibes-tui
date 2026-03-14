import OpenAI from 'openai';
import type { LLMProvider, SendMessageParams, StreamingResponse } from './provider.ts';

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

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      messages: messages as any,
      stream: true,
    }, { signal });

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        onText?.(delta);
      }
      
      if ((chunk as any).usage) {
        inputTokens = (chunk as any).usage.prompt_tokens || 0;
        outputTokens = (chunk as any).usage.completion_tokens || 0;
      }
    }

    return {
      content: fullContent,
      usage: { inputTokens, outputTokens },
    };
  }
}
