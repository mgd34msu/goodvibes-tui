import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import {
  toGeminiFunctionDeclarations,
  toGeminiContents,
  fromGeminiParts,
} from './tool-formats.ts';
import type { GeminiPart } from './tool-formats.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiCandidate {
  content: { parts: GeminiPart[]; role: string };
  finishReason: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * GeminiProvider — calls the Gemini generateContent API directly via fetch.
 * Tools are `functionDeclarations` inside a `tools` array.
 * Tool calls come as `functionCall` parts; results as `functionResponse` parts.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly models = [
    'gemini-3.1-pro-preview',
    'gemini-3-flash',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro',
  ];

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const { messages, tools, model, maxTokens, signal, systemPrompt } = params;

    return withRetry(async () => {
      const { contents, systemInstruction } = toGeminiContents(messages, systemPrompt);

      const body: Record<string, unknown> = { contents };

      if (systemInstruction) {
        body['systemInstruction'] = systemInstruction;
      }

      if (tools && tools.length > 0) {
        body['tools'] = [{
          functionDeclarations: toGeminiFunctionDeclarations(tools),
        }];
      }

      if (maxTokens) {
        body['generationConfig'] = { maxOutputTokens: maxTokens };
      }

      const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${this.apiKey}`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        throw new ProviderError(`Gemini API error ${res.status}: ${text}`, res.status);
      }

      const data = (await res.json()) as GeminiResponseBody;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const { text, toolCalls } = fromGeminiParts(parts);

      let stopReason: ChatResponse['stopReason'] = 'end';
      const finish = candidate?.finishReason;
      if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
      else if (toolCalls.length > 0) stopReason = 'tool_use';

      return {
        content: text,
        toolCalls,
        usage: {
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        stopReason,
      };
    });
  }
}
