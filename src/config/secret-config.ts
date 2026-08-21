import { isSecretRefInput, isDaemonOwnedConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { SecretScope, SecretStorageMedium } from './secrets.ts';

export const SECRET_CONFIG_KEYS = new Set<ConfigKey>([
  // Mailbox and CalDAV credentials. Their own CONFIG_SCHEMA descriptions read
  // "Stored in the daemon secret tier, never in config", and until they were
  // listed here that sentence was aspirational: the settings modal wrote them
  // as plain strings into a config JSON file, because membership in this set is
  // the thing that routes an edit through the secret manager instead.
  //
  // The daemon reads each of these back with
  // resolveConfigSecret('<key>') → GOODVIBES_<KEY>, which is exactly the store
  // key buildGoodVibesSecretKey() writes, see
  // daemon/handlers/inbox/providers/email.ts.
  'surfaces.email.password',
  'surfaces.email.imapPassword',
  'surfaces.email.imap.password',
  'surfaces.email.smtp.password',
  'surfaces.calendar.caldavPassword',
  // Telephony delivery credentials, same shape, same file, same gap.
  'surfaces.telephony.authToken',
  'surfaces.telephony.token',
  'surfaces.telephony.webhookSecret',
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
  // TUI-local synthetic sub-keys, one level under the SDK's real `payments`
  // section (not a scalar CONFIG_SCHEMA entry, same situation as
  // behavior.notifyAfterSeconds and the other synthetics in
  // settings-modal-data.ts), hence the cast. See input/payments-config.ts for why these are named flat
  // (payments.cardNumber, not payments.card.number): a flat one-level leaf is
  // the shape the real ConfigManager tolerates for an undeclared key.
  'payments.cardNumber' as ConfigKey,
  'payments.cardExpiry' as ConfigKey,
  'payments.cardCvv' as ConfigKey,
  'payments.cardholderName' as ConfigKey,
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

/**
 * Where a secret-backed write lands when the caller did not name a scope.
 *
 * A daemon-owned config key (`surfaces.*`, `payments.*`, `controlPlane.*`, ...)
 * names a credential the DAEMON executes with, not this interactive client, so
 * its secret material belongs in the daemon-scoped tier the daemon actually
 * reads, the same rule the SDK's config-ownership.ts already applies to the
 * `goodvibes://` reference that points at it.
 *
 * Defaulting these to 'user' (the historical behavior here) split the pair: the
 * reference landed in the daemon's own settings file, because ConfigManager
 * routes daemon-owned keys there, while the value it pointed at sat in a tier
 * the daemon never resolves. The surface reported success and the daemon found
 * nothing. For the mailbox password that is the whole feature failing silently,
 * the daemon is the process that polls IMAP and answers over Telegram, and it
 * does so with every surface closed. A payment card entered through
 * /payments card is the same shape of failure at purchase time.
 */
export function defaultSecretBackedScope(configKey: ConfigKey): SecretScope {
  return isDaemonOwnedConfigKey(configKey) ? 'daemon' : 'user';
}

/**
 * How a DAEMON-scoped credential reaches the daemon that will use it.
 *
 * One call, not two: `credentials.set` derives the store key, writes the value,
 * reads it back to verify, and only then points the config key at it. Doing
 * those halves separately from here would leave a window where the config
 * names a reference that resolves to nothing, which every reader treats as a
 * configured-but-broken credential.
 */
export interface DaemonCredentialWriter {
  set(configKey: string, value: string): Promise<unknown>;
  clear(configKey: string): Promise<void>;
}

export async function persistSecretBackedConfigValue(
  configManager: SecretBackedConfigManager,
  secretsManager: SecretBackedSecretStore | null | undefined,
  configKey: ConfigKey,
  rawValue: string,
  options: { readonly scope?: SecretScope; readonly daemonWriter?: DaemonCredentialWriter | null | undefined } = {},
): Promise<string> {
  const update = buildSecretBackedConfigUpdate(configKey, rawValue);
  const scope = options.scope ?? defaultSecretBackedScope(configKey);

  // A daemon-scoped credential is the daemon's to store, and the daemon does
  // the whole reference-and-value sequence atomically. This surface neither
  // writes the config key nor the secret in that case, it would be writing
  // both into a tree the daemon never reads.
  if (scope === 'daemon' && options.daemonWriter) {
    const trimmed = rawValue.trim();
    if (trimmed.length === 0) {
      await options.daemonWriter.clear(configKey);
      return '';
    }
    // Already a reference: the caller pasted one rather than a secret, so there
    // is nothing to store, the config value is the whole write.
    if (isSecretReferenceValue(trimmed)) return trimmed;
    await options.daemonWriter.set(configKey, rawValue);
    return update.configValue;
  }

  const medium = getSecretWriteMedium(configManager.get('storage.secretPolicy'));

  // 1. Validate config write first. If setDynamic throws, no secret is written (avoids orphans).
  configManager.setDynamic(configKey, update.configValue);

  // 2. Write new secret only after config accepted it.
  if (update.secretKey && update.secretValue !== undefined && secretsManager) {
    await secretsManager.set(update.secretKey, update.secretValue, { scope, medium });
  }

  // 3. Clear old secret, pass the same medium so plaintext-medium secrets are found for deletion.
  if (update.clearSecretKey && secretsManager?.delete) {
    await secretsManager.delete(update.clearSecretKey, { scope, medium });
  }

  return update.configValue;
}
