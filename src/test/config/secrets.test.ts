import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { SecretsManager, type SecretsManagerOptions } from '../../config/secrets.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(resolve(process.cwd(), '..'), 'gv-secrets-test-'));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SecretsManager', () => {
  let tmpDir: string;
  let encPath: string;
  let plaintextProjectPath: string;
  let secureUserPath: string;
  let plaintextUserPath: string;
  let projectRoot: string;
  let userHome: string;
  const createProjectStoreManager = (
    secureProjectFilePath = encPath,
    overrides: Partial<SecretsManagerOptions> = {},
  ): SecretsManager => new SecretsManager({
    projectRoot,
    globalHome: userHome,
    secureProjectFilePath,
    secureUserFilePath: secureUserPath,
    plaintextProjectFilePath: plaintextProjectPath,
    plaintextUserFilePath: plaintextUserPath,
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = makeTmpDir();
    encPath = join(tmpDir, '.goodvibes', 'tui', 'secrets.enc');
    plaintextProjectPath = join(tmpDir, '.goodvibes', 'tui.secrets.json');
    secureUserPath = join(tmpDir, 'home', '.goodvibes', 'tui', 'secrets.enc');
    plaintextUserPath = join(tmpDir, 'home', '.goodvibes', 'tui.secrets.json');
    projectRoot = join(tmpDir, 'workspace');
    userHome = join(tmpDir, 'home');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(userHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any env vars set during tests
    delete process.env['TEST_SECRET_KEY'];
    delete process.env['MY_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
  });

  describe('hierarchy-aware resolution', () => {
    test('prefers nearest project secure store over user secure store', async () => {
      delete process.env['OPENAI_API_KEY'];
      const manager = new SecretsManager({ projectRoot, globalHome: userHome });
      await manager.set('OPENAI_API_KEY', 'user-value', { scope: 'user', medium: 'secure' });
      await manager.set('OPENAI_API_KEY', 'project-value', { scope: 'project', medium: 'secure' });
      expect(await manager.get('OPENAI_API_KEY')).toBe('project-value');
    });

    test('preferred_secure reads plaintext fallback when present', async () => {
      delete process.env['ANTHROPIC_API_KEY'];
      const manager = new SecretsManager({
        projectRoot,
        globalHome: userHome,
        policy: 'preferred_secure',
      });
      await manager.set('ANTHROPIC_API_KEY', 'plaintext-value', { scope: 'project', medium: 'plaintext' });
      expect(await manager.get('ANTHROPIC_API_KEY')).toBe('plaintext-value');
    });

    test('require_secure ignores plaintext stores', async () => {
      delete process.env['GEMINI_API_KEY'];
      const writer = new SecretsManager({
        projectRoot,
        globalHome: userHome,
        policy: 'plaintext_allowed',
      });
      await writer.set('GEMINI_API_KEY', 'plaintext-value', { scope: 'project', medium: 'plaintext' });

      const reader = new SecretsManager({
        projectRoot,
        globalHome: userHome,
        policy: 'require_secure',
      });
      expect(await reader.get('GEMINI_API_KEY')).toBeNull();
    });

    test('inspect reports plaintext warnings when preferred secure falls back', async () => {
      const manager = new SecretsManager({
        projectRoot,
        globalHome: userHome,
        policy: 'preferred_secure',
      });
      await manager.set('OPENROUTER_API_KEY', 'plaintext-value', { scope: 'project', medium: 'plaintext' });
      const review = await manager.inspect();
      expect(review.policy).toBe('preferred_secure');
      expect(review.plaintextKeys).toBeGreaterThanOrEqual(1);
      expect(review.warnings).toContain('plaintext fallback secrets are present');
    });
  });

  // -------------------------------------------------------------------------
  // Tier 1 — Environment variable resolution
  // -------------------------------------------------------------------------

  describe('get() — env var resolution', () => {
    test('returns value from process.env when key is present', async () => {
      process.env['TEST_SECRET_KEY'] = 'super-secret-value';
      const mgr = createProjectStoreManager();
      const result = await mgr.get('TEST_SECRET_KEY');
      expect(result).toBe('super-secret-value');
    });

    test('env var takes priority over encrypted file', async () => {
      const mgr = createProjectStoreManager();
      // Store a value in encrypted file first
      await mgr.set('MY_API_KEY', 'file-value');
      // Then set env var
      process.env['MY_API_KEY'] = 'env-value';
      const result = await mgr.get('MY_API_KEY');
      expect(result).toBe('env-value');
    });

    test('returns null when key not found in env or file', async () => {
      const mgr = createProjectStoreManager();
      const result = await mgr.get('NONEXISTENT_KEY_XYZ');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Tier 2 — Encrypted file round-trip
  // -------------------------------------------------------------------------

  describe('set() + get() — round-trip', () => {
    test('stores and retrieves a secret from encrypted file', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('API_KEY', 'abc123');
      const result = await mgr.get('API_KEY');
      expect(result).toBe('abc123');
    });

    test('overwrites an existing key', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('API_KEY', 'first-value');
      await mgr.set('API_KEY', 'second-value');
      const result = await mgr.get('API_KEY');
      expect(result).toBe('second-value');
    });

    test('multiple keys coexist in same encrypted file', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('KEY_A', 'value-a');
      await mgr.set('KEY_B', 'value-b');
      expect(await mgr.get('KEY_A')).toBe('value-a');
      expect(await mgr.get('KEY_B')).toBe('value-b');
    });

    test('auto-creates parent directories on set()', async () => {
      const deepPath = join(tmpDir, 'deep', 'nested', 'secrets.enc');
      const mgr = createProjectStoreManager(deepPath);
      await mgr.set('KEY', 'val');
      expect(existsSync(deepPath)).toBe(true);
    });

    test('secret persists across SecretsManager instances (same file path)', async () => {
      const mgr1 = createProjectStoreManager();
      await mgr1.set('PERSISTENT_KEY', 'persistent-value');

      const mgr2 = createProjectStoreManager();
      const result = await mgr2.get('PERSISTENT_KEY');
      expect(result).toBe('persistent-value');
    });

    test('rejects relative owned roots and store paths', async () => {
      expect(() => new SecretsManager({ projectRoot: 'relative-project', globalHome: userHome })).toThrow(
        'SecretsManager projectRoot must be an absolute path.',
      );
      expect(() => new SecretsManager({ projectRoot, globalHome: 'relative-home' })).toThrow(
        'SecretsManager globalHome must be an absolute path.',
      );
      expect(() => new SecretsManager({
        projectRoot,
        globalHome: userHome,
        secureProjectFilePath: 'relative-store.enc',
      })).toThrow('SecretsManager secureProjectFilePath must be an absolute path.');
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    test('returns empty array when no secrets are stored', async () => {
      const mgr = createProjectStoreManager();
      const keys = await mgr.list();
      expect(keys).toEqual([]);
    });

    test('returns all stored key names', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('KEY_ONE', 'v1');
      await mgr.set('KEY_TWO', 'v2');
      const keys = await mgr.list();
      expect(keys.sort()).toEqual(['KEY_ONE', 'KEY_TWO']);
    });

    test('list() returns keys only — not values', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('SECRET', 'super-sensitive');
      const keys = await mgr.list();
      expect(keys).toContain('SECRET');
      expect(keys).not.toContain('super-sensitive');
    });
  });

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe('delete()', () => {
    test('removes a stored secret', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('DEL_KEY', 'value');
      await mgr.delete('DEL_KEY');
      const result = await mgr.get('DEL_KEY');
      expect(result).toBeNull();
    });

    test('remaining keys are unaffected after delete', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('KEEP', 'stay');
      await mgr.set('REMOVE', 'gone');
      await mgr.delete('REMOVE');
      expect(await mgr.get('KEEP')).toBe('stay');
      expect(await mgr.get('REMOVE')).toBeNull();
    });

    test('delete on non-existent key is a no-op', async () => {
      const mgr = createProjectStoreManager();
      // Should not throw
      await mgr.delete('NONEXISTENT');
      const keys = await mgr.list();
      expect(keys).toEqual([]);
    });

    test('delete removes key from list()', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('K1', 'v1');
      await mgr.set('K2', 'v2');
      await mgr.delete('K1');
      const keys = await mgr.list();
      expect(keys).not.toContain('K1');
      expect(keys).toContain('K2');
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted file format
  // -------------------------------------------------------------------------

  describe('encrypted file format', () => {
    test('encrypted file is valid JSON with iv, tag, and data fields', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('FORMAT_KEY', 'format-value');

      const raw = readFileSync(encPath, 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed).toHaveProperty('iv');
      expect(parsed).toHaveProperty('tag');
      expect(parsed).toHaveProperty('data');
    });

    test('iv, tag, data are hex strings', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('HEX_KEY', 'hex-value');

      const raw = readFileSync(encPath, 'utf-8');
      const parsed = JSON.parse(raw);

      expect(parsed.iv).toMatch(/^[0-9a-f]+$/);
      expect(parsed.tag).toMatch(/^[0-9a-f]+$/);
      expect(parsed.data).toMatch(/^[0-9a-f]+$/);
    });

    test('data field is not human-readable plaintext', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('SECRET_KEY', 'my-plaintext-secret');

      const raw = readFileSync(encPath, 'utf-8');
      // The plaintext secret should not appear anywhere in the stored file
      expect(raw).not.toContain('my-plaintext-secret');
    });

    test('iv differs between writes (random per write)', async () => {
      const mgr = createProjectStoreManager();
      await mgr.set('K', 'v1');
      const raw1 = readFileSync(encPath, 'utf-8');
      const iv1 = JSON.parse(raw1).iv;

      await mgr.set('K', 'v2');
      const raw2 = readFileSync(encPath, 'utf-8');
      const iv2 = JSON.parse(raw2).iv;

      expect(iv1).not.toBe(iv2);
    });

    test('corrupted file returns null and does not crash', async () => {
      // Write garbage to the file
      mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
      const { writeFileSync } = await import('fs');
      writeFileSync(encPath, 'NOT_VALID_JSON_OR_CIPHERTEXT', 'utf-8');

      const mgr = createProjectStoreManager();
      const result = await mgr.get('ANYTHING');
      expect(result).toBeNull();
    });

    test('corrupted file list() returns empty array', async () => {
      mkdirSync(join(tmpDir, '.goodvibes', 'tui'), { recursive: true });
      const { writeFileSync } = await import('fs');
      writeFileSync(encPath, '{"iv":"badhex","tag":"badhex","data":"badhex"}', 'utf-8');

      const mgr = createProjectStoreManager();
      const keys = await mgr.list();
      expect(keys).toEqual([]);
    });
  });
});
