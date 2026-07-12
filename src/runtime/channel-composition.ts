/**
 * channel-composition — route bindings, surface registry, and channel plugin
 * registry for the TUI composition root (split out of services.ts for the
 * line cap).
 *
 * RECORDED DIVERGENCE from the SDK composition root: SurfaceRegistry and
 * ChannelPluginRegistry are constructed WITHOUT the gate manager. The SDK's
 * surface gate map only names six surfaces (web/slack/discord/ntfy/webhook/
 * homeassistant) and reads every other adapter (telegram, whatsapp, signal,
 * imessage, msteams, ...) as OFF whenever a manager is present — no settings
 * key could re-enable them. Until the gate map covers every adapter, the
 * honest governing switch here stays the surfaces.<id>.enabled config each
 * adapter already reads, exactly as the feature surface's own
 * constant-binding rule states. RouteBindingManager keeps its manager — its
 * route-binding gate is a real registry feature.
 */

import { AutomationRouteStore } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '@pellux/goodvibes-sdk/platform/channels';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { FeatureFlagManager, RuntimeEventBus } from '@/runtime/index.ts';
import type { RuntimeStore } from './store/index.ts';

export interface ChannelComposition {
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
}

export function createChannelComposition(options: {
  readonly configManager: ConfigManager;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly featureFlags: FeatureFlagManager;
}): ChannelComposition {
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager: options.configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags: options.featureFlags,
  });
  const surfaceRegistry = new SurfaceRegistry(options.configManager, options.runtimeStore);
  const channelPlugins = new ChannelPluginRegistry();
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  return { routeBindings, surfaceRegistry, channelPlugins };
}
