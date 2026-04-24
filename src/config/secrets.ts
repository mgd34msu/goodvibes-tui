export type {
  SecretDeleteOptions,
  SecretRecord,
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorageMode,
  SecretStorageReview,
  SecretWriteOptions,
} from '@pellux/goodvibes-sdk/platform/config/secrets';

import {
  SecretsManager as SdkSecretsManager,
  type SecretsManagerOptions as SdkSecretsManagerOptions,
} from '@pellux/goodvibes-sdk/platform/config/secrets';
import { isSecretRefInput } from '@pellux/goodvibes-sdk/platform/config/secret-refs';

export type SecretsManagerOptions = Omit<SdkSecretsManagerOptions, 'surfaceRoot'>;

const RAW_SECRET_LITERAL_PREFIX = '__GOODVIBES_LITERAL_V1__';

function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function shouldStoreAsLiteral(value: string): boolean {
  return value.startsWith(RAW_SECRET_LITERAL_PREFIX)
    || (isSecretRefInput(value) && !isGoodVibesSecretRefInput(value));
}

function encodeLiteralSecret(value: string): string {
  return `${RAW_SECRET_LITERAL_PREFIX}${Buffer.from(JSON.stringify({ value }), 'utf-8').toString('base64url')}`;
}

function decodeLiteralSecret(value: string): string | null {
  if (!value.startsWith(RAW_SECRET_LITERAL_PREFIX)) return null;
  try {
    const decoded = Buffer.from(value.slice(RAW_SECRET_LITERAL_PREFIX.length), 'base64url').toString('utf-8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { value?: unknown }).value !== 'string') return null;
    return (parsed as { value: string }).value;
  } catch {
    return null;
  }
}

export class SecretsManager extends SdkSecretsManager {
  constructor(options: SecretsManagerOptions) {
    super({
      ...options,
      surfaceRoot: 'tui',
    });
  }

  override async get(key: string): Promise<string | null> {
    const envValue = process.env[key];
    if (envValue !== undefined && shouldStoreAsLiteral(envValue)) {
      return decodeLiteralSecret(envValue) ?? envValue;
    }

    const value = await super.get(key);
    if (value === null) return null;
    return decodeLiteralSecret(value) ?? value;
  }

  override async set(key: string, value: string, options?: Parameters<SdkSecretsManager['set']>[2]): Promise<void> {
    await super.set(key, shouldStoreAsLiteral(value) ? encodeLiteralSecret(value) : value, options);
  }
}
