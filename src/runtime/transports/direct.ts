import type { SharedApprovalRecord, SharedSessionRecord } from '../../control-plane/index.ts';
import {
  createDirectTransportServices,
  type DirectTransportServices,
} from '../foundation-services.ts';
import { createOperatorClient, type OperatorClient, type OperatorControlPlaneSnapshot, type OperatorProvidersSnapshot } from '../operator-client.ts';
import { createPeerClient, type PeerClient, type PeerClientSnapshot } from '../peer-client.ts';
import type { RuntimeServices } from '../services.ts';
import type { UiSessionSnapshot, UiTasksSnapshot } from '../ui-read-models.ts';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import { createDirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
import type { DirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export { createDirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';
export type { DirectClientTransport } from '@pellux/goodvibes-sdk/platform/runtime/transports/direct-client';

export interface DirectTransportSnapshot {
  readonly kind: 'direct';
  readonly operator: {
    readonly currentSession: UiSessionSnapshot;
    readonly tasks: UiTasksSnapshot;
    readonly approvals: readonly SharedApprovalRecord[];
    readonly sessions: readonly SharedSessionRecord[];
    readonly controlPlane: OperatorControlPlaneSnapshot;
    readonly providers: OperatorProvidersSnapshot;
    readonly shellPaths: ShellPathService;
  };
  readonly peer: PeerClientSnapshot;
}

export interface DirectTransport {
  readonly kind: 'direct';
  readonly operator: OperatorClient;
  readonly peer: PeerClient;
  getOperatorClient(): OperatorClient;
  getPeerClient(): PeerClient;
  snapshot(): Promise<DirectTransportSnapshot>;
}

export function createDirectTransportFromServices(services: DirectTransportServices): DirectTransport {
  const operator = createOperatorClient(services.operator);
  const peer = createPeerClient(services.peer);
  const transport = createDirectClientTransport(operator, peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<DirectTransportSnapshot> {
      const [providers] = await Promise.all([
        operator.providers.snapshot(),
      ]);
      return {
        kind: 'direct',
        operator: {
          currentSession: operator.sessions.current(),
          tasks: operator.tasks.snapshot(),
          approvals: operator.approvals.list(),
          sessions: operator.sessions.list(),
          controlPlane: operator.controlPlane.snapshot(),
          providers,
          shellPaths: operator.shellPaths,
        },
        peer: peer.getSnapshot(),
      };
    },
  });
}

export function createRuntimeDirectTransport(runtimeServices: RuntimeServices): DirectTransport {
  return createDirectTransportFromServices(createDirectTransportServices(runtimeServices));
}

export function createDirectTransport(runtimeServices: RuntimeServices): DirectTransport {
  return createRuntimeDirectTransport(runtimeServices);
}
