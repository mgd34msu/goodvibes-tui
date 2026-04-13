import type { DeterministicReplayEngine } from '../core/deterministic-replay.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { SecretsManager } from '../config/secrets.ts';
import type { SubscriptionManager } from '../config/subscriptions.ts';
import type { UserAuthManager } from '../security/user-auth.ts';
import type { ApiTokenAuditor } from '../security/token-audit.ts';
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
