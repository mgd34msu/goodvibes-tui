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
import { cacheHitTracker } from './cache-strategy.ts';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_CACHE_TTL_SECONDS = 3600;

interface GeminiCandidate {
  content: { parts: GeminiPart[]; role: string };
  finishReason: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
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
  readonly models: string[] = [];

  private apiKey: string;

  /** Active cached content resource name (e.g., "cachedContents/abc123") */
  private cachedContentName: string | null = null;
  /** Hash of the content that was cached (systemPrompt + tools + model) */
  private cachedContentHash: string | null = null;
  /** When the cache expires (epoch ms) */
  private cachedContentExpiry: number = 0;
  /** Hashes known to be below the 32K cache minimum — skip API call */
  private uncacheableHashes = new Set<string>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private computeCacheHash(
    systemPrompt: string | undefined,
    tools: import('./interface.ts').ChatRequest['tools'],
    model: string,
  ): string {
    const raw = (systemPrompt ?? '') + JSON.stringify(tools ?? []) + model;
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(raw);
    return hasher.digest('hex');
  }

  private async ensureCachedContent(
    systemPrompt: string | undefined,
    tools: import('./interface.ts').ChatRequest['tools'],
    model: string,
  ): Promise<string | null> {
    // Skip if no system prompt and no tools
    if (!systemPrompt && (!tools || tools.length === 0)) return null;

    const hash = this.computeCacheHash(systemPrompt, tools, model);

    // Skip if previously determined to be below 32K threshold
    if (this.uncacheableHashes.has(hash)) return null;

    // Reuse existing cache if hash matches and not expired (with 60s buffer)
    if (
      this.cachedContentName &&
      this.cachedContentHash === hash &&
      this.cachedContentExpiry > Date.now() + 60_000
    ) {
      return this.cachedContentName;
    }

    // Estimate tokens — skip if below 28K (conservative buffer below 32K minimum)
    const estimatedChars = (systemPrompt?.length ?? 0) + JSON.stringify(tools ?? []).length;
    if (estimatedChars / 3 < 28_000) {
      if (this.uncacheableHashes.size >= 50) this.uncacheableHashes.clear();
      this.uncacheableHashes.add(hash);
      logger.debug('[Gemini] Content below 32K cache threshold, skipping cache', {
        estimatedTokens: Math.round(estimatedChars / 3),
      });
      return null;
    }

    // Delete old cache if hash changed (fire-and-forget)
    if (this.cachedContentName && this.cachedContentHash !== hash) {
      const oldName = this.cachedContentName;
      fetch(`${GEMINI_API_BASE}/${oldName}`, {
        method: 'DELETE',
        headers: { 'x-goog-api-key': this.apiKey },
      }).catch(err => logger.warn('[Gemini] Failed to delete old cache', { error: String(err) }));
    }

    // Create new cached content
    try {
      const cacheBody: Record<string, unknown> = {
        model: `models/${model}`,
        ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
      };

      if (systemPrompt) {
        cacheBody['systemInstruction'] = { parts: [{ text: systemPrompt }] };
      }

      if (tools && tools.length > 0) {
        cacheBody['tools'] = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
      }

      const res = await fetch(`${GEMINI_API_BASE}/cachedContents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(cacheBody),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (text.includes('too few tokens') || text.includes('minimum')) {
          if (this.uncacheableHashes.size >= 50) this.uncacheableHashes.clear();
          this.uncacheableHashes.add(hash);
          logger.debug('[Gemini] Content below cache minimum', { status: res.status, error: text.slice(0, 200) });
        } else {
          logger.debug('[Gemini] Cache creation failed', { status: res.status, error: text.slice(0, 200) });
        }
        return null;
      }

      const data = await res.json() as { name: string; expireTime: string };
      this.cachedContentName = data.name;
      this.cachedContentHash = hash;
      this.cachedContentExpiry = new Date(data.expireTime).getTime();

      logger.info(`[Gemini] Created cache: ${data.name} (expires ${data.expireTime})`);
      return data.name;
    } catch (err) {
      logger.debug('[Gemini] Cache creation error', { error: String(err) });
      return null;
    }
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

      const cachedName = await this.ensureCachedContent(systemPrompt, tools, model);

      if (cachedName) {
        // Cached content already contains systemInstruction and tools — do NOT resend them
        body['cachedContent'] = cachedName;
      } else {
        if (systemInstruction) {
          body['systemInstruction'] = systemInstruction;
        }

        if (tools && tools.length > 0) {
          body['tools'] = [{
            functionDeclarations: toGeminiFunctionDeclarations(tools),
          }];
        }
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
      let cacheReadTokens = 0;
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
              cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount ?? cacheReadTokens;
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

      cacheHitTracker.recordTurn({
        inputTokens,
        cacheReadTokens,
      });

      return {
        content: text,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          // cacheWriteTokens is omitted: Gemini does not charge separately for cache writes
        },
        stopReason,
      };
    });
  }
}
