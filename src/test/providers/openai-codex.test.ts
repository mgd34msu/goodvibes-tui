import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICodexProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { OpenAIProvider } from '@pellux/goodvibes-sdk/platform/providers';
import { createTestManagers } from '../helpers/test-managers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const testManagers = createTestManagers();

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('OpenAI subscription-backed Codex path', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let root: string;

  beforeEach(() => {
    root = makeProjectTempDir('gv-openai-codex');
    process.env.HOME = root;
    process.chdir(root);
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('registry routes openai to subscriber provider when a subscription exists', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
      },
    });
    testManagers.subscriptionManager.saveSubscription({
      provider: 'openai',
      accessToken: token,
      tokenType: 'bearer',
      authMode: 'oauth',
      overrideAmbientApiKeys: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const provider = testManagers.providerRegistry.get('openai');
    if (!provider) throw new Error('Expected openai provider');
    expect(provider.name).toBe('openai-subscriber');
  });

  test('OpenAIProvider remains the normal API provider when used directly', () => {
    const provider = new OpenAIProvider('api-key');
    expect(provider.name).toBe('openai');
  });

  test('OpenAICodexProvider has a distinct subscriber provider identity', () => {
    const provider = new OpenAICodexProvider(testManagers.subscriptionManager);
    expect(provider.name).toBe('openai-subscriber');
  });
});
