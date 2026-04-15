import type { ArtifactReference } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ServiceRegistry } from '../../config/service-registry.ts';
import type { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts/index';
import type { ControlPlaneGateway } from '@pellux/goodvibes-sdk/platform/control-plane/gateway';
import type { RouteSurfaceKind } from '@pellux/goodvibes-sdk/platform/runtime/events/routes';

export type ChannelDeliverySurfaceKind = RouteSurfaceKind;
export type ChannelDeliveryTargetKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface ChannelDeliveryTarget {
  readonly kind: ChannelDeliveryTargetKind;
  readonly surfaceKind?: ChannelDeliverySurfaceKind;
  readonly address?: string;
  readonly routeId?: string;
  readonly label?: string;
}

export interface ChannelDeliveryRouteBinding {
  readonly id: string;
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly threadId?: string;
  readonly channelId?: string;
  readonly title?: string;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDeliveryRequest {
  readonly target: ChannelDeliveryTarget;
  readonly body: string;
  readonly title: string;
  readonly jobId: string;
  readonly runId: string;
  readonly agentId?: string;
  readonly status?: string;
  readonly includeLinks: boolean;
  readonly attachments?: readonly ArtifactReference[];
  readonly binding?: ChannelDeliveryRouteBinding;
}

export interface ChannelDeliveryResult {
  readonly responseId?: string;
}

export interface ChannelDeliveryStrategy {
  readonly id: string;
  canHandle(request: ChannelDeliveryRequest): boolean;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryRouterConfig {
  readonly configManager?: ConfigManager;
  readonly serviceRegistry?: ServiceRegistry;
  readonly artifactStore?: ArtifactStore;
  readonly controlPlaneGateway?: ControlPlaneGateway | null;
  readonly strategies?: readonly ChannelDeliveryStrategy[];
}
