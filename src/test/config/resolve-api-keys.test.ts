/**
 * G4, resolveApiKeys integration test
 *
 * Verifies the three-tier resolution: env var → SecretsManager encrypted store → omit.
 * Also verifies the /secrets command wiring via SecretsManager.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveApiKeys } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Every provider env var resolveApiKeys() reads, cleared before each test so an
 * ambient value (e.g. GITHUB_TOKEN from gh auth → github-copilot) can't leak
 * into the resolved set. Kept in sync with the SDK's api-keys provider table
 * (@pellux/goodvibes-sdk/platform/config/api-keys).
 */
const PROVIDER_ENV_VARS = [
  'OPENAI_API_KEY', 'OPENAI_KEY',
  'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_API_KEY',
  'INCEPTION_API_KEY',
  'OPENROUTER_API_KEY',
  'AIHUBMIX_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'OLLAMA_CLOUD_API_KEY', 'OLLAMA_API_KEY',
  'HF_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN',
  'NVIDIA_API_KEY',
  'LLM7_API_KEY',
  // github-copilot, the gap that let an ambient GITHUB_TOKEN leak in.
  'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROXY_API_KEY',
  // Remaining providers in the SDK table.
  'AI_GATEWAY_API_KEY', 'CLOUDFLARE_AI_GATEWAY_API_KEY', 'AZURE_OPENAI_API_KEY',
  'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'FIREWORKS_API_KEY',
  'LITELLM_API_KEY', 'MINIMAX_API_KEY', 'MODELSTUDIO_API_KEY', 'MOONSHOT_API_KEY',
  'QIANFAN_API_KEY', 'QWEN_API_KEY', 'SGLANG_API_KEY', 'STEPFUN_API_KEY',
  'TOGETHER_API_KEY', 'VENICE_API_KEY', 'VOLCANO_ENGINE_API_KEY',
  'XAI_API_KEY', 'XIAOMI_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY',
];

/** Snapshot env vars before each test. */
let savedEnvVars: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  savedEnvVars = {};
  for (const key of PROVIDER_ENV_VARS) {
    savedEnvVars[key] = process.env[key];
    delete process.env[key];
  }
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  for (const key of PROVIDER_ENV_VARS) {
    if (savedEnvVars[key] !== undefined) {
      process.env[key] = savedEnvVars[key];
    } else {
      delete process.env[key];
    }
  }
});

async function resolveWithEmptySecrets(): Promise<Record<string, string>> {
  const dir = makeTmpDir();
  try {
    const projectRoot = join(dir, 'workspace');
    const userHome = join(dir, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    const secrets = new SecretsManager({
      projectRoot,
      globalHome: userHome,
      secureProjectFilePath: join(dir, 'secrets.enc'),
    });
    return await resolveApiKeys(secrets);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createSecretsManager(root: string, secureProjectFilePath: string): SecretsManager {
  const projectRoot = join(root, 'workspace');
  const userHome = join(root, 'home');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  return new SecretsManager({
    projectRoot,
    globalHome: userHome,
    secureProjectFilePath,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('resolveApiKeys', () => {

  // -------------------------------------------------------------------------
  // Tier 1, environment variables win
  // -------------------------------------------------------------------------

  describe('Tier 1: env var resolution', () => {
    test('resolves openai from OPENAI_API_KEY env var', async () => {
      process.env['OPENAI_API_KEY'] = 'env-openai-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['openai']).toBe('env-openai-key');
    });

    test('resolves openai from OPENAI_KEY fallback env var', async () => {
      process.env['OPENAI_KEY'] = 'env-openai-fallback';
      const keys = await resolveWithEmptySecrets();
      expect(keys['openai']).toBe('env-openai-fallback');
    });

    test('resolves anthropic from ANTHROPIC_API_KEY env var', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'env-anthropic-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['anthropic']).toBe('env-anthropic-key');
    });

    test('resolves anthropic from CLAUDE_API_KEY fallback', async () => {
      process.env['CLAUDE_API_KEY'] = 'env-claude-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['anthropic']).toBe('env-claude-key');
    });

    test('resolves gemini from GEMINI_API_KEY env var', async () => {
      process.env['GEMINI_API_KEY'] = 'env-gemini-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['gemini']).toBe('env-gemini-key');
    });

    test('resolves gemini from GOOGLE_API_KEY fallback', async () => {
      process.env['GOOGLE_API_KEY'] = 'env-google-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['gemini']).toBe('env-google-key');
    });

    test('resolves gemini from GOOGLE_GEMINI_API_KEY fallback', async () => {
      process.env['GOOGLE_GEMINI_API_KEY'] = 'env-google-gemini-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['gemini']).toBe('env-google-gemini-key');
    });

    test('resolves inception from INCEPTION_API_KEY env var', async () => {
      process.env['INCEPTION_API_KEY'] = 'env-inception-key';
      const keys = await resolveWithEmptySecrets();
      expect(keys['inceptionlabs']).toBe('env-inception-key');
    });

    test('returns empty object when no env vars and no secrets', async () => {
      const keys = await resolveWithEmptySecrets();
      expect(Object.keys(keys)).toHaveLength(0);
    });

    test('returns only providers that have keys', async () => {
      process.env['OPENAI_API_KEY'] = 'key-a';
      const keys = await resolveWithEmptySecrets();
      expect(Object.keys(keys)).toEqual(['openai']);
      expect(keys['anthropic']).toBeUndefined();
    });

    test('OPENAI_API_KEY takes priority over OPENAI_KEY', async () => {
      process.env['OPENAI_API_KEY'] = 'primary';
      process.env['OPENAI_KEY'] = 'secondary';
      const keys = await resolveWithEmptySecrets();
      expect(keys['openai']).toBe('primary');
    });

  });

  // -------------------------------------------------------------------------
  // Tier 2, SecretsManager fallback when env var is absent
  // -------------------------------------------------------------------------

  describe('Tier 2: SecretsManager fallback', () => {
    test('falls back to SecretsManager for openai when env var absent', async () => {
      const tmpDir = makeTmpDir();
      const encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
      try {
        // Pre-store a key directly
        const mgr = createSecretsManager(tmpDir, encPath);
        await mgr.set('OPENAI_API_KEY', 'stored-openai-key');
        const keys = await resolveApiKeys(mgr);
        expect(keys['openai']).toBe('stored-openai-key');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('env var takes priority over stored secret', async () => {
      const tmpDir = makeTmpDir();
      const encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
      try {
        const mgr = createSecretsManager(tmpDir, encPath);
        await mgr.set('OPENAI_API_KEY', 'stored-value');

        // Now env var is set
        process.env['OPENAI_API_KEY'] = 'env-wins';
        const keys = await resolveApiKeys(mgr);
        expect(keys['openai']).toBe('env-wins');
      } finally {
        delete process.env['OPENAI_API_KEY'];
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('resolveApiKeys returns empty when no env vars and no stored secrets', async () => {
      const keys = await resolveWithEmptySecrets();
      expect(typeof keys).toBe('object');
    });

    test('multiple providers can be resolved simultaneously', async () => {
      process.env['OPENAI_API_KEY'] = 'oai';
      process.env['ANTHROPIC_API_KEY'] = 'ant';
      process.env['INCEPTION_API_KEY'] = 'inc';
      const keys = await resolveWithEmptySecrets();
      expect(keys['openai']).toBe('oai');
      expect(keys['anthropic']).toBe('ant');
      expect(keys['inceptionlabs']).toBe('inc');
    });
  });

  // -------------------------------------------------------------------------
  // SecretsManager API, verify the store used by /secrets command
  // -------------------------------------------------------------------------

  describe('SecretsManager API used by /secrets command', () => {
    test('set() + list() + delete() lifecycle', async () => {
      const tmpDir = makeTmpDir();
      const encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
      try {
        const mgr = createSecretsManager(tmpDir, encPath);

        // set
        await mgr.set('OPENAI_API_KEY', 'my-key');
        let keys = await mgr.list();
        expect(keys).toContain('OPENAI_API_KEY');

        // delete
        await mgr.delete('OPENAI_API_KEY');
        keys = await mgr.list();
        expect(keys).not.toContain('OPENAI_API_KEY');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('get() returns null for absent key', async () => {
      const tmpDir = makeTmpDir();
      const encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
      try {
        const mgr = createSecretsManager(tmpDir, encPath);
        const result = await mgr.get('NONEXISTENT_KEY');
        expect(result).toBeNull();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('values are not stored in plaintext', async () => {
      const { readFileSync } = await import('fs');
      const tmpDir = makeTmpDir();
      const encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
      try {
        const mgr = createSecretsManager(tmpDir, encPath);
        await mgr.set('MY_SECRET', 'plaintext-value-should-not-appear');
        const raw = readFileSync(encPath, 'utf-8');
        expect(raw).not.toContain('plaintext-value-should-not-appear');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
