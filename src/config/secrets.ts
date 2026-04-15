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

export type SecretsManagerOptions = Omit<SdkSecretsManagerOptions, 'surfaceRoot'>;

export class SecretsManager extends SdkSecretsManager {
  constructor(options: SecretsManagerOptions) {
    super({
      ...options,
      surfaceRoot: 'tui',
    });
  }
}
