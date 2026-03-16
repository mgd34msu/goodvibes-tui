/**
 * SecretsManager — three-tier secret resolution.
 *
 * Resolution order:
 *   1. Environment variable (process.env[key])
 *   2. Encrypted file at .goodvibes/tui/secrets.enc (AES-256-GCM)
 *   3. null (session prompt integration deferred to UI layer)
 *
 * Encryption: AES-256-GCM, key = SHA-256(hostname + username + 'goodvibes-secrets')
 * Storage format: { iv: hex, tag: hex, data: hex } where data is the encrypted
 *                 JSON blob of { key: value, ... }
 *
 * IMPORTANT: Secret values are never logged — only key names.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { hostname, userInfo } from 'os';
import { logger } from '../utils/logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EncryptedStore {
  iv: string;
  tag: string;
  data: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derives the AES-256 encryption key for the local secrets store.
 *
 * The key is SHA-256(hostname + username + 'goodvibes-secrets'), meaning:
 * - It is machine-specific: secrets encrypted on one host cannot be decrypted
 *   on another (different hostname).
 * - It is user-specific: secrets are scoped to the OS user account.
 * - Changing the machine hostname or username will render existing secrets
 *   unreadable. Re-enter secrets after hostname or username changes.
 */
function deriveEncryptionKey(): Buffer {
  const seed = hostname() + userInfo().username + 'goodvibes-secrets';
  return createHash('sha256').update(seed, 'utf8').digest();
}

function encrypt(plaintext: string, key: Buffer): EncryptedStore {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(store: EncryptedStore, key: Buffer): string {
  const iv = Buffer.from(store.iv, 'hex');
  const tag = Buffer.from(store.tag, 'hex');
  const data = Buffer.from(store.data, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// SecretsManager
// ---------------------------------------------------------------------------

export class SecretsManager {
  private readonly encryptedFilePath: string;
  private readonly encKey: Buffer;

  constructor(encryptedFilePath?: string) {
    this.encryptedFilePath =
      encryptedFilePath ?? join(process.cwd(), '.goodvibes', 'tui', 'secrets.enc');
    this.encKey = deriveEncryptionKey();
  }

  /**
   * Resolve a secret by key.
   * Priority: env var → encrypted file → null.
   * @param key - The secret key (e.g. 'OPENAI_API_KEY')
   */
  async get(key: string): Promise<string | null> {
    // Tier 1: Environment variable
    const envValue = process.env[key];
    if (envValue !== undefined) {
      logger.debug('SecretsManager: resolved from env', { key });
      return envValue;
    }

    // Tier 2: Encrypted file
    const secrets = this._readEncryptedFile();
    if (secrets !== null && key in secrets) {
      logger.debug('SecretsManager: resolved from encrypted file', { key });
      return secrets[key];
    }

    // Tier 3: Not found — UI layer handles prompting
    return null;
  }

  /**
   * Persist a secret to the encrypted file.
   * @param key - The secret key
   * @param value - The secret value (never logged)
   */
  async set(key: string, value: string): Promise<void> {
    const secrets = this._readEncryptedFile() ?? {};
    secrets[key] = value;
    this._writeEncryptedFile(secrets);
    logger.debug('SecretsManager: stored secret', { key });
  }

  /**
   * List all stored secret keys (not values).
   */
  async list(): Promise<string[]> {
    const secrets = this._readEncryptedFile();
    return secrets !== null ? Object.keys(secrets) : [];
  }

  /**
   * Delete a secret from the encrypted file.
   * No-op if the key does not exist.
   * @param key - The secret key to remove
   */
  async delete(key: string): Promise<void> {
    const secrets = this._readEncryptedFile();
    if (secrets === null || !(key in secrets)) return;
    delete secrets[key];
    this._writeEncryptedFile(secrets);
    logger.debug('SecretsManager: deleted secret', { key });
  }

  // ---------------------------------------------------------------------------
  // Private — encrypted file I/O
  // ---------------------------------------------------------------------------

  private _readEncryptedFile(): Record<string, string> | null {
    try {
      const raw = readFileSync(this.encryptedFilePath, 'utf-8');
      const store: EncryptedStore = JSON.parse(raw);
      const plaintext = decrypt(store, this.encKey);
      return JSON.parse(plaintext) as Record<string, string>;
    } catch (err) {
      // File not found is expected on first use — not a warning.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('SecretsManager: failed to read encrypted secrets file — treating as empty', {
          path: this.encryptedFilePath,
        });
      }
      return null;
    }
  }

  private _writeEncryptedFile(secrets: Record<string, string>): void {
    const dir = dirname(this.encryptedFilePath);
    mkdirSync(dir, { recursive: true });
    const plaintext = JSON.stringify(secrets);
    const store = encrypt(plaintext, this.encKey);
    writeFileSync(this.encryptedFilePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _secretsManager: SecretsManager | undefined;

export function getSecretsManager(): SecretsManager {
  if (!_secretsManager) _secretsManager = new SecretsManager();
  return _secretsManager;
}

/** Reset singleton — for testing only. */
export function _resetSecretsManagerForTesting(): void {
  _secretsManager = undefined;
}
