import { isSecretRefInput } from '@pellux/goodvibes-sdk/platform/config/secret-refs';
import type { ConfigKey } from './index.ts';
import type { SecretScope, SecretStorageMedium } from './secrets.ts';

export const SECRET_CONFIG_KEYS = new Set<ConfigKey>([
  'surfaces.slack.signingSecret',
  'surfaces.slack.botToken',
  'surfaces.slack.appToken',
  'surfaces.discord.botToken',
  'surfaces.ntfy.token',
  'surfaces.webhook.secret',
  'surfaces.homeassistant.accessToken',
  'surfaces.homeassistant.webhookSecret',
  'surfaces.telegram.botToken',
  'surfaces.telegram.webhookSecret',
  'surfaces.googleChat.verificationToken',
  'surfaces.signal.token',
  'surfaces.whatsapp.accessToken',
  'surfaces.whatsapp.verifyToken',
  'surfaces.whatsapp.signingSecret',
  'surfaces.imessage.token',
  'surfaces.msteams.appPassword',
  'surfaces.bluebubbles.password',
  'surfaces.mattermost.botToken',
  'surfaces.matrix.accessToken',
]);

export interface SecretBackedConfigUpdate {
  readonly configValue: string;
  readonly secretKey?: string;
  readonly secretValue?: string;
  readonly clearSecretKey?: string;
}

export interface SecretBackedConfigManager {
  readonly get: (key: ConfigKey) => unknown;
  readonly setDynamic: (key: ConfigKey, value: unknown) => void;
}

export interface SecretBackedSecretStore {
  readonly set: (key: string, value: string, options?: { readonly scope?: SecretScope; readonly medium?: SecretStorageMedium }) => Promise<void>;
  readonly delete?: (key: string, options?: { readonly scope?: SecretScope; readonly medium?: SecretStorageMedium }) => Promise<void>;
}

export function isSecretConfigKey(key: string): key is ConfigKey {
  return SECRET_CONFIG_KEYS.has(key as ConfigKey);
}

export function normalizeSecretKeyPart(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function buildGoodVibesSecretKey(configKey: string): string {
  return `GOODVIBES_${configKey.split('.').map(normalizeSecretKeyPart).filter(Boolean).join('_')}`;
}

export function buildGoodVibesSecretRef(secretKey: string): string {
  return `goodvibes://secrets/goodvibes/${encodeURIComponent(secretKey)}`;
}

export function isSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

export function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isSecretReferenceValue(normalized);
}

export function getSecretWriteMedium(policy: unknown): SecretStorageMedium {
  if (policy === 'plaintext_allowed') return 'plaintext';
  return 'secure';
}

export function buildSecretBackedConfigUpdate(configKey: ConfigKey, rawValue: string): SecretBackedConfigUpdate {
  const value = rawValue.trim();
  const secretKey = buildGoodVibesSecretKey(configKey);
  if (value.length === 0) {
    return {
      configValue: '',
      clearSecretKey: secretKey,
    };
  }
  if (isSecretReferenceValue(value)) {
    return { configValue: value };
  }
  return {
    configValue: buildGoodVibesSecretRef(secretKey),
    secretKey,
    secretValue: rawValue,
  };
}

export async function persistSecretBackedConfigValue(
  configManager: SecretBackedConfigManager,
  secretsManager: SecretBackedSecretStore | null | undefined,
  configKey: ConfigKey,
  rawValue: string,
  options: { readonly scope?: SecretScope } = {},
): Promise<string> {
  const update = buildSecretBackedConfigUpdate(configKey, rawValue);
  const scope = options.scope ?? 'user';
  if (update.secretKey && update.secretValue !== undefined && secretsManager) {
    await secretsManager.set(update.secretKey, update.secretValue, {
      scope,
      medium: getSecretWriteMedium(configManager.get('storage.secretPolicy')),
    });
  }
  if (update.clearSecretKey && secretsManager?.delete) {
    await secretsManager.delete(update.clearSecretKey, { scope });
  }
  configManager.setDynamic(configKey, update.configValue);
  return update.configValue;
}
