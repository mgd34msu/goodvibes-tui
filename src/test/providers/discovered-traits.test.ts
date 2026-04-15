import { describe, expect, test } from 'bun:test';
import { getDiscoveredTraits } from '@pellux/goodvibes-sdk/platform/providers/discovered-traits';

describe('getDiscoveredTraits', () => {
  test('LM Studio advertises reasoning-aware native capabilities', () => {
    const traits = getDiscoveredTraits('lm-studio');
    expect(traits.adapter).toBe('lm-studio');
    expect(traits.modelCapabilities.reasoning).toBe(true);
    expect(traits.reasoningEffort).toEqual(['instant', 'low', 'medium', 'high']);
    expect(traits.providerCapabilities?.reasoningControls).toBe(true);
  });

  test('Ollama advertises native adapter and reasoning controls', () => {
    const traits = getDiscoveredTraits('ollama');
    expect(traits.adapter).toBe('ollama');
    expect(traits.reasoningFormat).toBe('llamacpp');
    expect(traits.providerCapabilities?.jsonMode).toBe(true);
    expect(traits.modelCapabilities.reasoning).toBe(true);
  });

  test('vLLM remains OAI-first but exposes explicit custom capabilities', () => {
    const traits = getDiscoveredTraits('vllm');
    expect(traits.adapter).toBe('vllm');
    expect(traits.providerCapabilities?.parallelTools).toBe(false);
    expect(traits.providerCapabilities?.jsonMode).toBe(true);
  });
});
