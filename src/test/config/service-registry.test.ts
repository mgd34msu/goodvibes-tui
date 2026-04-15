import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-service-registry-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeServicesFile(dir: string, services: Record<string, unknown>): string {
  const filePath = join(dir, 'services.json');
  writeFileSync(filePath, JSON.stringify(services, null, 2) + '\n', 'utf-8');
  return filePath;
}

function createRegistry(
  dir: string,
  filePath: string,
  overrides: Partial<{
    secretsManager: SecretsManager;
    subscriptionManager: SubscriptionManager;
  }> = {},
): ServiceRegistry {
  return new ServiceRegistry(filePath, {
    secretsManager: overrides.secretsManager ?? createSecretsManager(dir),
    subscriptionManager: overrides.subscriptionManager ?? new SubscriptionManager(join(dir, 'subscriptions.json')),
  });
}

function createSecretsManager(dir: string, secureProjectFilePath = join(dir, 'secrets.enc')): SecretsManager {
  const projectRoot = join(dir, 'workspace');
  const globalHome = join(dir, 'home');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(globalHome, { recursive: true });
  return new SecretsManager({
    projectRoot,
    globalHome,
    secureProjectFilePath,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServiceRegistry - getAll / get', () => {
  test('returns empty object when services file is missing', () => {
    const dir = makeTmpDir();
    try {
      const registry = createRegistry(dir, join(dir, 'missing.json'));
      expect(registry.getAll()).toEqual({});
      expect(registry.get('openai')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns parsed service configs from valid file', () => {
    const dir = makeTmpDir();
    try {
      const filePath = writeServicesFile(dir, {
        openai: { name: 'openai', baseUrl: 'https://api.openai.com', authType: 'bearer', tokenKey: 'OPENAI_API_KEY' },
        github: { name: 'github', baseUrl: 'https://api.github.com', authType: 'bearer', tokenKey: 'GITHUB_TOKEN' },
      });
      const registry = createRegistry(dir, filePath);
      const all = registry.getAll();
      expect(Object.keys(all)).toHaveLength(2);
      expect(all['openai'].authType).toBe('bearer');
      expect(all['openai'].tokenKey).toBe('OPENAI_API_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get returns null for unknown service', () => {
    const dir = makeTmpDir();
    try {
      const filePath = writeServicesFile(dir, {
        openai: { name: 'openai', authType: 'bearer', tokenKey: 'OPENAI_API_KEY' },
      });
      const registry = createRegistry(dir, filePath);
      expect(registry.get('unknown-service')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('get returns correct config for known service', () => {
    const dir = makeTmpDir();
    try {
      const filePath = writeServicesFile(dir, {
        myservice: { name: 'myservice', baseUrl: 'https://example.com', authType: 'api-key', tokenKey: 'MY_KEY', apiKeyHeader: 'X-Custom-Key' },
      });
      const registry = createRegistry(dir, filePath);
      const cfg = registry.get('myservice');
      expect(cfg).not.toBeNull();
      expect(cfg!.authType).toBe('api-key');
      expect(cfg!.apiKeyHeader).toBe('X-Custom-Key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ServiceRegistry - resolveAuth bearer', () => {
  let dir: string;
  let encPath: string;
  let servicesPath: string;
  let subscriptionManager: SubscriptionManager;

  beforeEach(() => {
    dir = makeTmpDir();
    encPath = join(dir, 'secrets.enc');
    servicesPath = join(dir, 'services.json');
    subscriptionManager = new SubscriptionManager(join(dir, 'subscriptions.json'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns Authorization Bearer header when token is available', async () => {
    // Store the token in a temp secrets file
    const secrets = createSecretsManager(dir, encPath);
    await secrets.set('OPENAI_API_KEY', 'sk-test-token-123');

    writeServicesFile(dir, {
      openai: { name: 'openai', authType: 'bearer', tokenKey: 'OPENAI_API_KEY' },
    });

    // Override env to use our temp secrets
    const registry = new ServiceRegistry(servicesPath, {
      secretsManager: secrets,
      subscriptionManager,
    });
    // We need a registry that uses our secrets instance.
    // Spy approach: use env var override (tier 1 of SecretsManager)
    const origEnv = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-token-123';
    try {
      const headers = await registry.resolveAuth('openai');
      expect(headers).not.toBeNull();
      expect(headers!['Authorization']).toBe('Bearer sk-test-token-123');
    } finally {
      if (origEnv === undefined) {
        delete process.env['OPENAI_API_KEY'];
      } else {
        process.env['OPENAI_API_KEY'] = origEnv;
      }
    }
  });

  test('returns null when bearer token is not available', async () => {
    writeServicesFile(dir, {
      openai: { name: 'openai', authType: 'bearer', tokenKey: 'OPENAI_API_KEY_MISSING_XYZ' },
    });
    const registry = new ServiceRegistry(servicesPath, {
      secretsManager: createSecretsManager(dir, encPath),
      subscriptionManager,
    });
    const headers = await registry.resolveAuth('openai');
    expect(headers).toBeNull();
  });

  test('returns null for unknown service', async () => {
    writeServicesFile(dir, {});
    const registry = new ServiceRegistry(servicesPath, {
      secretsManager: createSecretsManager(dir, encPath),
      subscriptionManager,
    });
    const headers = await registry.resolveAuth('nonexistent');
    expect(headers).toBeNull();
  });

  test('prefers provider subscription token over ambient bearer token', async () => {
    writeServicesFile(dir, {
      openai: { name: 'openai', authType: 'bearer', tokenKey: 'OPENAI_API_KEY', providerId: 'openai' },
    });
    process.env['OPENAI_API_KEY'] = 'env-token';
    const oauth = {
      authUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1/callback',
      scopes: ['chat'],
    } as const;
    subscriptionManager.beginOAuthLogin('openai', oauth);
    globalThis.fetch = ((async () => ({
      ok: true,
      json: async () => ({ access_token: 'subscription-token', token_type: 'Bearer' }),
    })) as unknown) as typeof fetch;
    await subscriptionManager.completeOAuthLogin('openai', oauth, 'code-123');
    const registry = new ServiceRegistry(servicesPath, {
      secretsManager: createSecretsManager(dir, encPath),
      subscriptionManager,
    });
    const headers = await registry.resolveAuth('openai');
    expect(headers).not.toBeNull();
    expect(headers!['Authorization']).toBe('Bearer subscription-token');
  });
});

describe('ServiceRegistry - resolveAuth basic', () => {
  test('returns Authorization Basic header with username:password encoded', async () => {
    const dir = makeTmpDir();
    try {
      writeServicesFile(dir, {
        myapi: {
          name: 'myapi',
          authType: 'basic',
          tokenKey: 'MYAPI_USER',
          passwordKey: 'MYAPI_PASS',
        },
      });
      const registry = createRegistry(dir, join(dir, 'services.json'));

      const origUser = process.env['MYAPI_USER'];
      const origPass = process.env['MYAPI_PASS'];
      process.env['MYAPI_USER'] = 'testuser';
      process.env['MYAPI_PASS'] = 'testpass';
      try {
        const headers = await registry.resolveAuth('myapi');
        expect(headers).not.toBeNull();
        const expected = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');
        expect(headers!['Authorization']).toBe(expected);
      } finally {
        if (origUser === undefined) delete process.env['MYAPI_USER'];
        else process.env['MYAPI_USER'] = origUser;
        if (origPass === undefined) delete process.env['MYAPI_PASS'];
        else process.env['MYAPI_PASS'] = origPass;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses empty string for missing password in basic auth', async () => {
    const dir = makeTmpDir();
    try {
      writeServicesFile(dir, {
        myapi: {
          name: 'myapi',
          authType: 'basic',
          tokenKey: 'MYAPI_USER_ONLY',
          // no passwordKey
        },
      });
      const registry = createRegistry(dir, join(dir, 'services.json'));

      const origUser = process.env['MYAPI_USER_ONLY'];
      process.env['MYAPI_USER_ONLY'] = 'admin';
      try {
        const headers = await registry.resolveAuth('myapi');
        expect(headers).not.toBeNull();
        const expected = 'Basic ' + Buffer.from('admin:').toString('base64');
        expect(headers!['Authorization']).toBe(expected);
      } finally {
        if (origUser === undefined) delete process.env['MYAPI_USER_ONLY'];
        else process.env['MYAPI_USER_ONLY'] = origUser;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ServiceRegistry - resolveAuth api-key', () => {
  test('returns default X-API-Key header when apiKeyHeader is not set', async () => {
    const dir = makeTmpDir();
    try {
      writeServicesFile(dir, {
        myservice: { name: 'myservice', authType: 'api-key', tokenKey: 'MY_SERVICE_KEY' },
      });
      const registry = createRegistry(dir, join(dir, 'services.json'));

      const origKey = process.env['MY_SERVICE_KEY'];
      process.env['MY_SERVICE_KEY'] = 'abc-secret-key';
      try {
        const headers = await registry.resolveAuth('myservice');
        expect(headers).not.toBeNull();
        expect(headers!['X-API-Key']).toBe('abc-secret-key');
      } finally {
        if (origKey === undefined) delete process.env['MY_SERVICE_KEY'];
        else process.env['MY_SERVICE_KEY'] = origKey;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns custom header when apiKeyHeader is set', async () => {
    const dir = makeTmpDir();
    try {
      writeServicesFile(dir, {
        myservice: { name: 'myservice', authType: 'api-key', tokenKey: 'MY_SERVICE_KEY2', apiKeyHeader: 'X-Auth-Token' },
      });
      const registry = createRegistry(dir, join(dir, 'services.json'));

      const origKey = process.env['MY_SERVICE_KEY2'];
      process.env['MY_SERVICE_KEY2'] = 'xyz-secret';
      try {
        const headers = await registry.resolveAuth('myservice');
        expect(headers).not.toBeNull();
        expect(headers!['X-Auth-Token']).toBe('xyz-secret');
        expect(headers!['X-API-Key']).toBeUndefined();
      } finally {
        if (origKey === undefined) delete process.env['MY_SERVICE_KEY2'];
        else process.env['MY_SERVICE_KEY2'] = origKey;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when api key is not found', async () => {
    const dir = makeTmpDir();
    try {
      writeServicesFile(dir, {
        myservice: { name: 'myservice', authType: 'api-key', tokenKey: 'TOTALLY_MISSING_KEY_XYZ_999' },
      });
      const registry = createRegistry(dir, join(dir, 'services.json'));
      const headers = await registry.resolveAuth('myservice');
      expect(headers).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ServiceRegistry - tolerates invalid file', () => {
  test('returns empty when file contains invalid JSON', () => {
    const dir = makeTmpDir();
    try {
      const filePath = join(dir, 'services.json');
      writeFileSync(filePath, '{ not valid json }', 'utf-8');
      const registry = createRegistry(dir, filePath);
      expect(registry.getAll()).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
