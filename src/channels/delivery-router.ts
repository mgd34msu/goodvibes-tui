import { ArtifactStore } from '../artifacts/index.ts';
import { ConfigManager } from '../config/manager.ts';
import { ServiceRegistry } from '../config/service-registry.ts';
import type { ControlPlaneGateway } from '../control-plane/gateway.ts';
import {
  createDiscordDeliveryStrategy,
  createGoogleChatDeliveryStrategy,
  createNtfyDeliveryStrategy,
  createSlackDeliveryStrategy,
  createTelegramDeliveryStrategy,
  createWebControlPlaneDeliveryStrategy,
  createWebhookDeliveryStrategy,
} from './delivery/strategies-core.ts';
import {
  createBlueBubblesDeliveryStrategy,
  createIMessageDeliveryStrategy,
  createSignalDeliveryStrategy,
  createWhatsAppDeliveryStrategy,
} from './delivery/strategies-bridge.ts';
import {
  createMSTeamsDeliveryStrategy,
  createMattermostDeliveryStrategy,
  createMatrixDeliveryStrategy,
} from './delivery/strategies-enterprise.ts';
import { resolveChannelDeliverySurfaceKind } from './delivery/shared.ts';
import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
} from './delivery/types.ts';

export type {
  ChannelDeliveryResult,
  ChannelDeliveryRouteBinding,
  ChannelDeliveryRouterConfig,
  ChannelDeliveryStrategy,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
  ChannelDeliveryTargetKind,
} from './delivery/types.ts';

export { resolveChannelDeliverySurfaceKind } from './delivery/shared.ts';

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
    const configManager = config.configManager ?? new ConfigManager();
    const serviceRegistry = config.serviceRegistry ?? new ServiceRegistry();
    const artifactStore = config.artifactStore ?? new ArtifactStore({ configManager });
    this.controlPlaneGateway = config.controlPlaneGateway ?? null;
    this.strategies = [
      ...(config.strategies ?? createDefaultChannelDeliveryStrategies(
        configManager,
        serviceRegistry,
        artifactStore,
        () => this.controlPlaneGateway,
      )),
    ];
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
