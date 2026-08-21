import { describe, expect, test } from 'bun:test';
import { getDiscoveredTraits } from '@pellux/goodvibes-sdk/platform/providers';

describe('getDiscoveredTraits', () => {
  test('LM Studio advertises reasoning-aware native capabilities', () => {
    const traits = getDiscoveredTraits('lm-studio');
    expect(traits.adapter).toBe('lm-studio');
    expect(traits.modelCapabilities.reasoning).toBe(true);
    // A discovered server advertises a spec, not a bare list, the wire shape
    // matters as much as the level names.
    expect(traits.reasoningEffort?.kind).toBe('effort');
    expect(traits.reasoningEffort?.values).toEqual(['instant', 'low', 'medium', 'high']);
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
