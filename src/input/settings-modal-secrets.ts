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

export function setSecretBackedSettingValue(args: {
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  setConfigValue: (key: ConfigKey, value: unknown) => void;
}): void {
  const { key, value, configManager, secretsManager, setConfigValue } = args;
  if (!secretsManager) {
    setConfigValue(key, value.trim());
    return;
  }

  const update = buildSecretBackedConfigUpdate(key, value);
  // A daemon-owned key (surfaces.*, controlPlane.*, ...) names a credential the
  // daemon executes with, so its value goes to the daemon tier — the one the
  // daemon reads with every surface closed. Everything else stays at user
  // scope. See defaultSecretBackedScope.
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
