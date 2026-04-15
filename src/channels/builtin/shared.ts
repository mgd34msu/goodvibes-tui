import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../../adapters/index.ts';
import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { ConfigManager } from '../../config/manager.ts';
import type { SurfacesConfig } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { SecretsManager } from '../../config/secrets.ts';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { SharedApprovalRecord } from '../../control-plane/index.ts';
import type { ChannelDeliveryRouter } from '../delivery-router.ts';
import type { ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels/policy-manager';
import type { ChannelPluginRegistry } from '../plugin-registry.ts';
import type { ChannelProviderRuntimeManager } from '../provider-runtime.ts';
import type { RouteBindingManager } from '../route-manager.ts';

export type ManagedSurface =
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';

export interface BuiltinChannelRuntimeDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly providerRuntime?: ChannelProviderRuntimeManager;
  readonly deliveryRouter: ChannelDeliveryRouter;
  readonly surfaceDeliveryEnabled: (surface: ManagedSurface) => boolean;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  readonly deliverSurfaceProgress: (pending: unknown, progress: string) => Promise<void>;
  readonly deliverSlackAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverDiscordAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverNtfyAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverWebhookAgentReply: (pending: unknown, message: string) => Promise<void>;
  readonly deliverSlackApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverDiscordApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverNtfyApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
  readonly deliverWebhookApprovalUpdate: (approval: SharedApprovalRecord, binding: AutomationRouteBinding) => Promise<void>;
}

type SurfaceConfigSection = keyof SurfacesConfig;

export const CHANNEL_SETUP_VERSION = 1;
export const DEFAULT_SECRET_BACKENDS = [
  'env',
  'goodvibes',
  'service-registry',
  '1password',
  'bitwarden',
  'vaultwarden',
  'bitwarden-secrets-manager',
  'bws',
  'manual',
] as const;

export function configSectionForSurface(surface: ManagedSurface): SurfaceConfigSection {
  switch (surface) {
    case 'slack':
      return 'slack';
    case 'discord':
      return 'discord';
    case 'ntfy':
      return 'ntfy';
    case 'webhook':
      return 'webhook';
    case 'telegram':
      return 'telegram';
    case 'google-chat':
      return 'googleChat';
    case 'signal':
      return 'signal';
    case 'whatsapp':
      return 'whatsapp';
    case 'imessage':
      return 'imessage';
    case 'msteams':
      return 'msteams';
    case 'bluebubbles':
      return 'bluebubbles';
    case 'mattermost':
      return 'mattermost';
    case 'matrix':
      return 'matrix';
  }
}
