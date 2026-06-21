import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretsManager } from '../../config/secrets.ts';
import {
  buildGoodVibesSecretKey,
  isSecretReferenceValue,
} from '../../config/secret-config.ts';

export interface DaemonCredentialStore {
  /**
   * Resolve a goodvibes://secrets/ reference OR a raw secret key to its
   * plaintext value (daemon-internal only).
   */
  resolveRef(ref: string): Promise<string | null>;
  /**
   * Resolve a config-key-derived secret
   * (e.g. 'surfaces.slack.botToken' → GOODVIBES_SURFACES_SLACK_BOT_TOKEN).
   */
  resolveConfigSecret(configKey: string): Promise<string | null>;
  /** Store a daemon-owned credential. scope defaults 'user'. */
  put(
    secretKey: string,
    value: string,
    opts?: { scope?: 'user' | 'project'; medium?: 'plaintext' | 'secure' },
  ): Promise<void>;
  has(secretKey: string): Promise<boolean>;
}

/** Extract the trailing secret-key segment from a goodvibes://secrets/ reference. */
function secretKeyFromReference(ref: string): string {
  const normalized = ref.trim();
  const segments = normalized.split('/');
  const last = segments[segments.length - 1] ?? '';
  return decodeURIComponent(last);
}

export function createDaemonCredentialStore(secrets: SecretsManager): DaemonCredentialStore {
  return {
    async resolveRef(ref: string): Promise<string | null> {
      const key = isSecretReferenceValue(ref) ? secretKeyFromReference(ref) : ref;
      return secrets.get(key);
    },
    async resolveConfigSecret(configKey: string): Promise<string | null> {
      return secrets.get(buildGoodVibesSecretKey(configKey));
    },
    async put(
      secretKey: string,
      value: string,
      opts?: { scope?: 'user' | 'project'; medium?: 'plaintext' | 'secure' },
    ): Promise<void> {
      await secrets.set(secretKey, value, {
        scope: opts?.scope ?? 'user',
        medium: opts?.medium ?? 'secure',
      });
    },
    async has(secretKey: string): Promise<boolean> {
      const value = await secrets.get(secretKey);
      return value !== null && value.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// At-rest encryption helper for drafts (draft body must be encrypted at rest).
// ---------------------------------------------------------------------------

export interface AtRestCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const DEFAULT_DRAFT_KEY_NAME = 'GOODVIBES_DAEMON_DRAFT_AESKEY';
const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

async function loadOrCreateKey(
  store: DaemonCredentialStore,
  keyName: string,
): Promise<Buffer> {
  const existing = await store.resolveRef(keyName);
  if (existing && existing.length > 0) {
    const buf = Buffer.from(existing, 'base64');
    if (buf.length === AES_KEY_BYTES) return buf;
  }
  const generated = randomBytes(AES_KEY_BYTES);
  await store.put(keyName, generated.toString('base64'), { medium: 'secure' });
  return generated;
}

/**
 * Create an AES-256-GCM at-rest cipher backed by a daemon-owned key.
 * encrypt() returns base64(iv | tag | ciphertext). Uses node:crypto (Bun-compatible).
 * NEVER log resolved keys or plaintext.
 */
export function createAtRestCipher(
  store: DaemonCredentialStore,
  keyName: string = DEFAULT_DRAFT_KEY_NAME,
): AtRestCipher {
  let keyPromise: Promise<Buffer> | null = null;
  const getKey = (): Promise<Buffer> => {
    if (!keyPromise) keyPromise = loadOrCreateKey(store, keyName);
    return keyPromise;
  };

  return {
    async encrypt(plaintext: string): Promise<string> {
      const key = await getKey();
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, encrypted]).toString('base64');
    },
    async decrypt(ciphertext: string): Promise<string> {
      const key = await getKey();
      const raw = Buffer.from(ciphertext, 'base64');
      const iv = raw.subarray(0, GCM_IV_BYTES);
      const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
      const data = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf-8');
    },
  };
}
