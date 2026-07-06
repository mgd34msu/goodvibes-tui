/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
export type { DeepReadonly } from '@pellux/goodvibes-sdk/platform/config';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig, PersistedFlagState } from '@pellux/goodvibes-sdk/platform/config';
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
export { ConfigError } from '@pellux/goodvibes-sdk/platform/types';

import { readFileSync } from 'fs';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { GoodVibesConfig } from '@pellux/goodvibes-sdk/platform/config';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { getProviderIdFromModel } from './provider-model.ts';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return getProviderIdFromModel(configManager.get('provider.model'));
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

export function getConfiguredSystemPrompt(configManager: Pick<ConfigManager, 'get'>): string | undefined {
  const file = configManager.get('provider.systemPromptFile');
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    logger.debug('systemPrompt file read failed (non-fatal)', { file, error: summarizeError(err) });
    return undefined;
  }
}

export { getConfiguredApiKeys, resolveApiKeys } from '@pellux/goodvibes-sdk/platform/config';

// Client-side credential-status read (honest-degrade, status-only). When the
// TUI acts as a client of an adopted external daemon it reads provider/model/secret
// STATUS from that daemon's `credentials.get`, never from its own surfaceRoot store.
export {
  credentialReadModeFromHostMode,
  deriveCredentialAvailability,
  readClientCredentialStatus,
} from './credential-availability.ts';
export type {
  CredentialAvailability,
  CredentialReadMode,
  CredentialStatusEntry,
  CredentialStatusOutcome,
} from './credential-availability.ts';
