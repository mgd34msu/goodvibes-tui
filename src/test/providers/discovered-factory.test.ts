import { describe, expect, test } from 'bun:test';
import type { DiscoveredServer } from '../../discovery/scanner.ts';
import { createDiscoveredProvider } from '../../providers/discovered-factory.ts';
import { LocalAIProvider, TGIProvider, VLLMProvider } from '../../providers/discovered-compat.ts';
import { LlamaCppProvider } from '../../providers/llama-cpp.ts';
import { LMStudioProvider } from '../../providers/lm-studio.ts';
import { OpenAICompatProvider } from '../../providers/openai-compat.ts';
import { OllamaProvider } from '../../providers/ollama.ts';

describe('createDiscoveredProvider', () => {
  test('uses LMStudioProvider for detected LM Studio servers', () => {
    const server: DiscoveredServer = {
      name: 'LM Studio',
      host: '127.0.0.1',
      port: 1234,
      baseURL: 'http://127.0.0.1:1234/v1',
      models: ['model-a'],
      serverType: 'lm-studio',
    };

    const provider = createDiscoveredProvider(server);
    expect(provider).toBeInstanceOf(LMStudioProvider);
  });

  test('keeps generic compat providers for other discovered servers', () => {
    const server: DiscoveredServer = {
      name: 'Ollama',
      host: '127.0.0.1',
      port: 11434,
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['qwen3'],
      serverType: 'ollama',
    };

    const provider = createDiscoveredProvider(server);
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  test('uses dedicated compat subclasses for vLLM, llama.cpp, TGI, and LocalAI', () => {
    const cases: Array<[DiscoveredServer['serverType'], new (...args: never[]) => object]> = [
      ['vllm', VLLMProvider],
      ['llamacpp', LlamaCppProvider],
      ['tgi', TGIProvider],
      ['localai', LocalAIProvider],
    ];

    for (const [serverType, klass] of cases) {
      const provider = createDiscoveredProvider({
        name: serverType,
        host: '127.0.0.1',
        port: 9999,
        baseURL: 'http://127.0.0.1:9999/v1',
        models: ['model-a'],
        serverType,
      });
      expect(provider).toBeInstanceOf(klass);
    }
  });

  test('unknown servers still use the generic compat provider', () => {
    const provider = createDiscoveredProvider({
      name: 'Unknown',
      host: '127.0.0.1',
      port: 9000,
      baseURL: 'http://127.0.0.1:9000/v1',
      models: ['model-a'],
      serverType: 'unknown',
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
  });
});
