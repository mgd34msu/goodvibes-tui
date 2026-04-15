import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { ServiceRegistry } from '../config/service-registry.ts';
import type { ControlPlaneGateway } from '@pellux/goodvibes-sdk/platform/control-plane/gateway';
import {
  createDiscordDeliveryStrategy,
  createGoogleChatDeliveryStrategy,
  createNtfyDeliveryStrategy,
  createSlackDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createWebControlPlaneDeliveryStrategy,
  createWebhookDeliveryStrategy,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/strategies-core';
import {
  createBlueBubblesDeliveryStrategy,
  createIMessageDeliveryStrategy,
  createSignalDeliveryStrategy,
  createWhatsAppDeliveryStrategy,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/strategies-bridge';
import {
  createMSTeamsDeliveryStrategy,
  createMattermostDeliveryStrategy,
  createMatrixDeliveryStrategy,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/strategies-enterprise';
import { resolveChannelDeliverySurfaceKind } from '@pellux/goodvibes-sdk/platform/channels/delivery/shared';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/types';

export type {
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
  ChannelDeliveryTargetKind,
} from '@pellux/goodvibes-sdk/platform/channels/delivery/types';

export { resolveChannelDeliverySurfaceKind } from '@pellux/goodvibes-sdk/platform/channels/delivery/shared';

export function createDefaultChannelDeliveryStrategies(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  getControlPlaneGateway: () => ControlPlaneGateway | null,
): ChannelDeliveryStrategy[] {
  return [
    createWebhookDeliveryStrategy(configManager, artifactStore),
    createSlackDeliveryStrategy(serviceRegistry, configManager, artifactStore),
    createDiscordDeliveryStrategy(serviceRegistry, configManager, artifactStore),
    createNtfyDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWebControlPlaneDeliveryStrategy(configManager, artifactStore, getControlPlaneGateway),
    createTelegramDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createGoogleChatDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createSignalDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createWhatsAppDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createIMessageDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMSTeamsDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createBlueBubblesDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMattermostDeliveryStrategy(configManager, serviceRegistry, artifactStore),
    createMatrixDeliveryStrategy(configManager, serviceRegistry, artifactStore),
  ];
}

export class ChannelDeliveryRouter {
  private readonly strategies: ChannelDeliveryStrategy[];
  private controlPlaneGateway: ControlPlaneGateway | null;

  constructor(config: ChannelDeliveryRouterConfig = {}) {
    this.controlPlaneGateway = config.controlPlaneGateway ?? null;
    if (config.strategies) {
      this.strategies = [...config.strategies];
      return;
    }
    if (!config.configManager || !config.serviceRegistry || !config.artifactStore) {
      throw new Error(
        'ChannelDeliveryRouter requires configManager, serviceRegistry, and artifactStore when using builtin delivery strategies.',
      );
    }
    this.strategies = createDefaultChannelDeliveryStrategies(
      config.configManager,
      config.serviceRegistry,
      config.artifactStore,
      () => this.controlPlaneGateway,
    );
  }

  setControlPlaneGateway(gateway: ControlPlaneGateway | null): void {
    this.controlPlaneGateway = gateway;
  }

  listStrategies(): readonly ChannelDeliveryStrategy[] {
    return [...this.strategies];
  }

  registerStrategy(strategy: ChannelDeliveryStrategy, options: { readonly replace?: boolean } = {}): void {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategy.id);
    if (existingIndex >= 0) {
      if (!options.replace) {
        throw new Error(`Channel delivery strategy already registered: ${strategy.id}`);
      }
      this.strategies.splice(existingIndex, 1, strategy);
      return;
    }
    this.strategies.push(strategy);
  }

  unregisterStrategy(strategyId: string): boolean {
    const existingIndex = this.strategies.findIndex((entry) => entry.id === strategyId);
    if (existingIndex < 0) return false;
    this.strategies.splice(existingIndex, 1);
    return true;
  }

  async deliver(request: ChannelDeliveryRequest): Promise<string | undefined> {
    const strategy = this.strategies.find((entry) => entry.canHandle(request));
    if (!strategy) {
      const surfaceKind = resolveChannelDeliverySurfaceKind(request.target);
      throw new Error(`Unsupported channel delivery target: ${request.target.kind}:${surfaceKind ?? 'unknown'}`);
    }
    const result = await strategy.deliver(request);
    return result.responseId;
  }
}
