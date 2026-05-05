import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomProviders } from '@pellux/goodvibes-sdk/platform/providers';

const tempRoots: string[] = [];

function makeProvidersDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-custom-providers-'));
  tempRoots.push(root);
  return join(root, 'providers');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('custom provider loader', () => {
  test('loads providers from an explicit owned directory', async () => {
    const providersDir = makeProvidersDir();
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(join(providersDir, 'ollama.json'), JSON.stringify({
      name: 'ollama-local',
      displayName: 'Ollama Local',
      type: 'openai-compat',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: [{
        id: 'llama3.2',
        displayName: 'Llama 3.2',
        contextWindow: 32768,
        capabilities: {
          toolCalling: true,
          codeEditing: true,
          reasoning: false,
          multimodal: false,
        },
      }],
    }, null, 2));

    const result = await loadCustomProviders({ providersDir });

    expect(result.warnings).toEqual([]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.config.name).toBe('ollama-local');
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.registryKey).toBe('ollama-local:llama3.2');
  });
});
