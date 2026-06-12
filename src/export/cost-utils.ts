// ---------------------------------------------------------------------------
// cost-utils — canonical pricing source for token cost calculations (consumed by CostTrackerPanel and share-runtime)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  input: number;
  output: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Free tier
  'openrouter/free': { input: 0, output: 0 },

  // InceptionLabs
  'mercury-2':    { input: 0.50, output: 1.50 },
  'mercury-edit': { input: 0.50, output: 1.50 },

  // OpenAI
  'gpt-5.4':              { input: 5,    output: 15 },
  'gpt-5.3-chat-latest':  { input: 3,    output: 10 },
  'gpt-5-mini':           { input: 0.15, output: 0.60 },
  'gpt-5-nano':           { input: 0.05, output: 0.20 },
  'gpt-oss-120b':         { input: 0,    output: 0 },

  // Anthropic
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-6': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },

  // Google
  'gemini-3.1-pro':        { input: 1.25,  output: 5 },
  'gemini-3-flash':        { input: 0.075, output: 0.30 },
  'gemini-3.1-flash-lite': { input: 0.02,  output: 0.10 },
  'gemini-2.5-pro':        { input: 1.25,  output: 5 },
};

/**
 * getPricing — resolve USD-per-1M-token pricing for a model ID.
 * Exact match first; then prefix/substring; falls back to zero.
 */
export function getPricing(modelId: string): ModelPricing {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]!;
  if (modelId.endsWith(':free')) return { input: 0, output: 0 };
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key) || modelId.includes(key)) return pricing;
  }
  return { input: 0, output: 0 };
}

/**
 * calcSessionCost — compute total session cost in USD given raw token counters
 * and the active model ID. Same formula used by CostTrackerPanel.onTurnComplete.
 *
 * inputTokens    — cumulative input tokens
 * outputTokens   — cumulative output tokens
 * cacheRead      — cumulative cache-read tokens
 * cacheWrite     — cumulative cache-write tokens
 * modelId        — registry model identifier
 */
export function calcSessionCost(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  modelId: string,
): number {
  const pricing = getPricing(modelId);
  // Cache reads/writes count toward billable input side (same convention as panel)
  const billableInput = inputTokens + cacheRead + cacheWrite;
  return (billableInput * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
