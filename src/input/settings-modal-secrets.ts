import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import type { SecretsManager } from '../config/secrets.ts';
import {
  buildSecretBackedConfigUpdate,
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
  if (update.secretKey && update.secretValue !== undefined) {
    void secretsManager.set(update.secretKey, update.secretValue, {
      scope: 'user',
      medium: getSecretWriteMedium(configManager.get('storage.secretPolicy')),
    }).catch((error) => {
      logger.error('SettingsModal: failed to store secret config value', { key, error: summarizeError(error) });
    });
  }
  if (update.clearSecretKey) {
    void secretsManager.delete(update.clearSecretKey, { scope: 'user' }).catch((error) => {
      logger.error('SettingsModal: failed to clear secret config value', { key, error: summarizeError(error) });
    });
  }
  setConfigValue(key, update.configValue);
}
