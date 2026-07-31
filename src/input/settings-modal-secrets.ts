import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { SecretsManager } from '../config/secrets.ts';
import {
  buildSecretBackedConfigUpdate,
  defaultSecretBackedScope,
  getSecretWriteMedium,
} from '../config/secret-config.ts';

export type SettingsSecretsManager = Pick<SecretsManager, 'delete' | 'set'>;

/**
 * The daemon's own credential write, when this app has a daemon to write to.
 *
 * A daemon-scoped credential is two writes that only work together — the secret
 * value and the config reference that points at it — and `credentials.set` does
 * both, verifying the value reads back before it touches the config. Splitting
 * them across a process boundary leaves a window where the config names a
 * reference resolving to nothing, which every reader treats as a
 * configured-but-broken credential.
 */
export interface SettingsDaemonCredentialWriter {
  set(configKey: string, value: string): Promise<unknown>;
  clear(configKey: string): Promise<void>;
}

export function setSecretBackedSettingValue(args: {
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  /** Present when a daemon is adopted; absent leaves the historical local path. */
  daemonCredentials?: SettingsDaemonCredentialWriter | null;
  setConfigValue: (key: ConfigKey, value: unknown) => void;
  /** Surface the daemon's refusal; without it a failed write would be silent. */
  onError?: (message: string) => void;
}): void {
  const { key, value, configManager, secretsManager, setConfigValue } = args;
  if (!secretsManager) {
    setConfigValue(key, value.trim());
    return;
  }

  // A daemon-scoped credential never lands in this surface's own tree: the
  // daemon is the process that spends it, and a copy here would be a credential
  // sitting somewhere nothing reads it from.
  if (defaultSecretBackedScope(key) === 'daemon' && args.daemonCredentials) {
    const writer = args.daemonCredentials;
    const trimmed = value.trim();
    const done = trimmed.length === 0 ? writer.clear(key) : writer.set(key, value);
    void done.catch((error) => {
      const message = summarizeError(error);
      logger.error('SettingsModal: the daemon refused the credential write', { key, error: message });
      args.onError?.(`Saving that credential failed: ${message}`);
    });
    return;
  }

  const update = buildSecretBackedConfigUpdate(key, value);
  // A daemon-owned key (surfaces.*, payments.*, controlPlane.*, ...) names a
  // credential the daemon itself executes with, so its secret material lands in
  // the daemon tier — the one the daemon reads with every surface closed —
  // regardless of which client edited it. Everything else stays at user scope.
  // See secret-config.ts's defaultSecretBackedScope.
  const scope = defaultSecretBackedScope(key);
  if (update.secretKey && update.secretValue !== undefined) {
    void secretsManager.set(update.secretKey, update.secretValue, {
      scope,
      medium: getSecretWriteMedium(configManager.get('storage.secretPolicy')),
    }).catch((error) => {
      logger.error('SettingsModal: failed to store secret config value', { key, error: summarizeError(error) });
    });
  }
  if (update.clearSecretKey) {
    void secretsManager.delete(update.clearSecretKey, { scope }).catch((error) => {
      logger.error('SettingsModal: failed to clear secret config value', { key, error: summarizeError(error) });
    });
  }
  setConfigValue(key, update.configValue);
}
