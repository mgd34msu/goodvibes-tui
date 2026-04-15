import type { DeterministicReplayEngine } from '@pellux/goodvibes-sdk/platform/core/deterministic-replay';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { SecretsManager } from '../config/secrets.ts';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type { ApiTokenAuditor } from '@pellux/goodvibes-sdk/platform/security/token-audit';
import type { WebhookNotifier } from '../integrations/webhooks.ts';
import type { UiReadModels } from './ui-read-models.ts';

export interface CommandPlatformShellServices {
  readonly readModels?: UiReadModels;
  readonly serviceRegistry?: ServiceRegistry;
  readonly subscriptionManager?: SubscriptionManager;
  readonly secretsManager?: SecretsManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly tokenAuditor?: ApiTokenAuditor;
  readonly replayEngine?: DeterministicReplayEngine;
  readonly webhookNotifier?: WebhookNotifier;
}

export interface CreateShellPlatformServicesOptions extends CommandPlatformShellServices {}

export function createShellPlatformServices(
  options: CreateShellPlatformServicesOptions,
): CommandPlatformShellServices {
  const {
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
  } = options;

  return {
    readModels,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    localUserAuthManager,
    tokenAuditor,
    replayEngine,
    webhookNotifier,
  };
}
