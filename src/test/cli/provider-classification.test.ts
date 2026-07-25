import { describe, expect, test } from 'bun:test';
import { classifyProviderSetup } from '../../providers/provider-classification.ts';

describe('provider setup classification', () => {
  test('classifies subscription providers separately from API-key OpenAI', () => {
    expect(classifyProviderSetup({ providerId: 'openai', authMode: 'api-key', modelCount: 50 }).setupClass).toBe('api-key');
    expect(classifyProviderSetup({ providerId: 'openai-subscriber', authMode: 'oauth', modelCount: 0 }).setupClass).toBe('subscription');
  });

  test('classifies self-hosted and no-key/free providers', () => {
    expect(classifyProviderSetup({ providerId: 'sglang', authMode: 'anonymous', configured: true }).setupClass).toBe('self-hosted');
    expect(classifyProviderSetup({ providerId: 'synthetic', authMode: 'none', modelCount: 10 }).setupClass).toBe('local');
    expect(classifyProviderSetup({ providerId: 'example-free', authMode: 'anonymous', modelCount: 3 }).setupClass).toBe('no-key-free');
  });

  test('classifies cloud account providers separately from simple API keys', () => {
    expect(classifyProviderSetup({ providerId: 'amazon-bedrock', authMode: 'anonymous', modelCount: 90 }).setupClass).toBe('cloud-account');
    expect(classifyProviderSetup({ providerId: 'unknown-provider', authMode: 'none', configured: false, modelCount: 0 }).setupClass).toBe('unknown');
  });
});
