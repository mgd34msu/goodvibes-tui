import type { LLMProvider, ChatRequest, ChatResponse } from './interface.ts';
import { ProviderError } from '../types/errors.ts';
import { logger } from '../utils/logger.ts';

// --- Types ---

interface SyntheticBackend {
  providerName: string;
  modelId: string;
}

// --- Model Map ---

const SYNTHETIC_MODEL_MAP: Record<string, SyntheticBackend[]> = {
  'gpt-oss-120b': [
    { providerName: 'groq', modelId: 'openai/gpt-oss-120b' },
    { providerName: 'huggingface', modelId: 'openai/gpt-oss-120b' },
    { providerName: 'nvidia', modelId: 'openai/gpt-oss-120b' },
    { providerName: 'ollama-cloud', modelId: 'gpt-oss:120b' },
    { providerName: 'openai', modelId: 'gpt-oss-120b' },
    { providerName: 'openrouter', modelId: 'openai/gpt-oss-120b:free' },
  ],
  'minimax-m2.5': [
    { providerName: 'huggingface', modelId: 'MiniMaxAI/MiniMax-M2.5' },
    { providerName: 'nvidia', modelId: 'minimaxai/minimax-m2.5' },
    { providerName: 'ollama-cloud', modelId: 'minimax-m2.5' },
    { providerName: 'openrouter', modelId: 'minimax/minimax-m2.5:free' },
    { providerName: 'aihubmix', modelId: 'coding-minimax-m2.5-free' },
    { providerName: 'aihubmix', modelId: 'minimax-m2.5-free' },
  ],
  'kimi-k2.5': [
    { providerName: 'huggingface', modelId: 'moonshotai/Kimi-K2.5' },
    { providerName: 'nvidia', modelId: 'moonshotai/kimi-k2.5' },
    { providerName: 'ollama-cloud', modelId: 'kimi-k2.5' },
  ],
  'qwen-3.5-397b': [
    { providerName: 'huggingface', modelId: 'Qwen/Qwen3.5-397B-A17B' },
    { providerName: 'nvidia', modelId: 'qwen/qwen3.5-397b-a17b' },
    { providerName: 'ollama-cloud', modelId: 'qwen3.5:397b' },
  ],
  'glm-5': [
    { providerName: 'huggingface', modelId: 'zai-org/GLM-5' },
    { providerName: 'nvidia', modelId: 'z-ai/glm5' },
    { providerName: 'ollama-cloud', modelId: 'glm-5' },
    { providerName: 'aihubmix', modelId: 'coding-glm-5-free' },
    { providerName: 'aihubmix', modelId: 'coding-glm-5-turbo-free' },
  ],
  'nemotron-3-super-120b': [
    { providerName: 'nvidia', modelId: 'nvidia/nemotron-3-super-120b-a12b' },
    { providerName: 'ollama-cloud', modelId: 'nemotron-3-super' },
    { providerName: 'openrouter', modelId: 'nvidia/nemotron-3-super-120b-a12b:free' },
  ],
};

// --- Rate Limit Detection ---

function isRateLimitError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (err.statusCode === 429) return true;
    const msg = err.message.toLowerCase();
    return /rate.limit|too many requests|quota exceeded|throttl/.test(msg);
  }
  // Some providers throw plain errors with rate limit messages
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('429') || /rate.limit|too many requests|quota exceeded/.test(msg);
  }
  return false;
}

// --- Default cooldown ---
const DEFAULT_COOLDOWN_MS = 60_000;

// --- SyntheticProvider ---

export class SyntheticProvider implements LLMProvider {
  readonly name = 'synthetic';
  readonly models: string[];

  // Track cooldowns: syntheticModelId -> array of expiresAt timestamps indexed by backend position
  private cooldowns = new Map<string, number[]>();
  // Track active backend: syntheticModelId -> current backend index
  private activeBackend = new Map<string, number>();

  constructor(private registryGetter: () => { get(name: string): LLMProvider }) {
    this.models = Object.keys(SYNTHETIC_MODEL_MAP);
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    const syntheticId = params.model;
    const backends = SYNTHETIC_MODEL_MAP[syntheticId];
    if (!backends || backends.length === 0) {
      throw new ProviderError(`Unknown synthetic model: ${syntheticId}`, 400);
    }

    const now = Date.now();
    if (!this.cooldowns.has(syntheticId)) {
      this.cooldowns.set(syntheticId, new Array(backends.length).fill(0));
    }
    const cooldownArr = this.cooldowns.get(syntheticId)!;

    // Reset to preferred backend if its cooldown expired
    if (cooldownArr[0] <= now) {
      this.activeBackend.set(syntheticId, 0);
    }

    const startIndex = this.activeBackend.get(syntheticId) ?? 0;
    const errors: Array<{ backend: SyntheticBackend; error: Error }> = [];
    let shortestCooldown = Infinity;

    // Try each backend in order, starting from active
    for (let i = 0; i < backends.length; i++) {
      const idx = (startIndex + i) % backends.length;
      const backend = backends[idx];

      // Skip if still in cooldown
      if (cooldownArr[idx] > now) {
        const remaining = cooldownArr[idx] - now;
        if (remaining < shortestCooldown) shortestCooldown = remaining;
        continue;
      }

      // Resolve provider
      let provider: LLMProvider;
      try {
        provider = this.registryGetter().get(backend.providerName);
      } catch (err) {
        logger.debug(`[Synthetic] Backend ${backend.providerName} not available: ${err}`);
        continue;
      }

      // Attempt the call
      // Note: if onDelta is set and a rate limit occurs mid-stream, partial content
      // from this backend will already have been delivered to the caller. The next
      // backend starts fresh, which may produce garbled output. In practice, rate
      // limits reject before streaming begins (at the HTTP level), so this is
      // unlikely to trigger. A future improvement could buffer deltas until the
      // first successful chunk confirms no rate limit.
      try {
        const response = await provider.chat({
          ...params,
          model: backend.modelId,
        });

        // Success — update active backend
        this.activeBackend.set(syntheticId, idx);
        logger.info(`[Synthetic] ${syntheticId} served by ${backend.providerName} (${backend.modelId})`);
        return response;
      } catch (err) {
        if (isRateLimitError(err)) {
          // Record cooldown
          const cooldownMs = (err instanceof ProviderError && err.retryAfterMs)
            ? err.retryAfterMs
            : DEFAULT_COOLDOWN_MS;
          cooldownArr[idx] = now + cooldownMs;
          this.cooldowns.set(syntheticId, cooldownArr);

          logger.info(`[Synthetic] ${backend.providerName} rate-limited for ${syntheticId}, cooldown ${Math.round(cooldownMs / 1000)}s`);
          errors.push({ backend, error: err as Error });
          continue;
        }
        // Non-rate-limit error — don't failover, re-throw
        throw err;
      }
    }

    // All backends exhausted
    const cooldownSec = shortestCooldown === Infinity ? '?' : Math.round(shortestCooldown / 1000);
    throw new ProviderError(
      `All backends for ${syntheticId} are rate-limited. Shortest cooldown expires in ${cooldownSec}s. ` +
      `Tried: ${errors.map(e => e.backend.providerName).join(', ')}`,
      429,
    );
  }
}
