import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { REASONING_BUDGET_MAP } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { withRetry } from '../utils/retry.ts';
import { logger } from '../utils/logger.ts';
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
 * Uses streamGenerateContent for real-time token delivery when onDelta is provided.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  /** Maps function call name → thoughtSignature for the current turn. */
  private thoughtSignatures = new Map<string, string>();
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
    const { messages, tools, model, maxTokens, signal, systemPrompt, onDelta, reasoningEffort } = params;

    return withRetry(async () => {
      const { contents, systemInstruction } = toGeminiContents(messages, systemPrompt);

      // Inject thoughtSignatures into both model functionCall parts and user functionResponse parts
      // (Gemini thinking models require the signature on both sides of the round-trip)
      for (const c of contents) {
        for (const part of c.parts) {
          const p = part as Record<string, unknown>;
          if (p.functionCall) {
            const fc = p.functionCall as { name: string };
            const sig = this.thoughtSignatures.get(fc.name);
            if (sig) p.thoughtSignature = sig;
          }
          if (p.functionResponse) {
            const fr = p.functionResponse as { name: string };
            const sig = this.thoughtSignatures.get(fr.name);
            if (sig) p.thoughtSignature = sig;
          }
        }
      }

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

      if (reasoningEffort) {
        const budget = REASONING_BUDGET_MAP[reasoningEffort];
        if (budget !== undefined) {
          body['generationConfig'] = {
            ...(body['generationConfig'] as Record<string, unknown> ?? {}),
            thinking_config: { thinking_budget: budget },
          };
        }
      }

      // Always use streaming endpoint; parse NDJSON chunks
      const url = `${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
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
        throw new ProviderError(`Gemini API error ${res.status}: ${text}`, res.status);
      }

      // Accumulate state from streaming chunks
      const allParts: GeminiPart[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let lastFinishReason = '';
      let streamedText = '';

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
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            let chunk: GeminiResponseBody;
            try {
              chunk = JSON.parse(data) as GeminiResponseBody;
            } catch {
              logger.debug('Gemini SSE: failed to parse JSON chunk', { data });
              continue;
            }

            const candidate = chunk.candidates?.[0];
            if (candidate) {
              const parts = candidate.content?.parts ?? [];
              for (const part of parts) {
                allParts.push(part);
                if (part.text && onDelta) {
                  streamedText += part.text;
                  onDelta({ content: part.text });
                }
                if (part.functionCall) {
                  // Capture thoughtSignature if present (Gemini thinking models)
                  if ((part as Record<string, unknown>).thoughtSignature) {
                    this.thoughtSignatures.set(part.functionCall.name, (part as Record<string, unknown>).thoughtSignature as string);
                  }
                  if (onDelta) {
                    onDelta({ toolCalls: [{ index: 0, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) }] });
                  }
                }
              }
              if (candidate.finishReason) {
                lastFinishReason = candidate.finishReason;
              }
            }

            if (chunk.usageMetadata) {
              inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Use streamed text directly if available (avoids re-parsing duplicated text parts)
      const { text: parsedText, toolCalls } = fromGeminiParts(allParts);
      // Prefer streamedText for content; fall back to parsed if no streaming happened
      const text = streamedText || parsedText;

      let stopReason: ChatResponse['stopReason'] = 'end';
      if (lastFinishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
      else if (toolCalls.length > 0) stopReason = 'tool_use';

      // Clear old signatures — new ones were captured from this response's functionCall parts
      // (kept across calls within a tool-use loop, cleared when no new functionCalls arrive)
      if (toolCalls.length === 0) {
        this.thoughtSignatures.clear();
      }

      return {
        content: text,
        toolCalls,
        usage: { inputTokens, outputTokens },
        stopReason,
      };
    });
  }
}
