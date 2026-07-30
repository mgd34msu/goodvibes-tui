/**
 * device-posture-composition.ts — the paired-phone feature inside THIS daemon.
 *
 * A phone pairs with whichever daemon the person runs, and for this owner that
 * daemon is hosted by the terminal app. Until this module existed the app had no
 * device posture at all: `device.nodes.maxPaired` was enforced at the pairing
 * path (SDK-side) and `device.capabilities.mode` was an onboarding toggle, while
 * the other eleven `device.*` keys were recorded, read back, and governed
 * nothing — the capability service they describe was never built here, so there
 * was nothing for them to govern.
 *
 * The feature itself is platform-owned (`platform/devices`): the settings→policy
 * mapping, the grants ledger, the capture store, the housekeeping sweeps, the
 * confirmation flow, and the `phone` tool. This module supplies the three seams
 * that are actually ours and nothing else:
 *
 *   - the peer transport — the same DistributedRuntimeManager the remote surface
 *     pairs devices onto, so a phone paired here is a node here,
 *   - the approval path — the shared approval broker, so the confirmation
 *     appears wherever the person is looking (terminal, web app, companion),
 *   - the storage root and the live config manager.
 *
 * Constructing this starts nothing. `startHousekeeping()` is called from the
 * bootstrap tail: grants and captures both outlive a restart, so a grant whose
 * phone is gone, or a capture torn by a crash, is reaped BEFORE the first
 * request of this run is served — and the periodic sweep after it is what keeps
 * a long-running daemon from going days without one. A failed sweep is logged
 * and the app still runs: housekeeping failing is a reason to say so, not a
 * reason to refuse to start.
 */
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { createDevicePostureRuntime, registerDevicePhoneTool } from '@pellux/goodvibes-sdk/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePhoneToolRegistry,
  DevicePostureRuntime,
} from '@pellux/goodvibes-sdk/platform/devices';
import { registerDevicesGatewayMethods } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** Who this surface records in the device audit trail. */
export const TUI_DEVICE_ACTOR = 'tui:phone-tool';

export interface DevicePostureCompositionOptions {
  readonly configManager: ConfigManager;
  /** The runtime devices pair onto; its listPeers/invokePeer are the transport. */
  readonly distributedRuntime: DevicePeerTransport;
  readonly approvals: DeviceApprovalBridge;
  /** Surface-scoped directory the grants ledger, captures and disclosure live in. */
  readonly stateDirectory: string;
  /**
   * Binding the catalog turns devices.nodes.list / devices.grants.* /
   * devices.housekeeping.run from cataloged-but-unhandled into real handlers,
   * which is what makes the grants surface work in the web app and the companion
   * rather than only through this app's own tool.
   */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly getSessionId?: (() => string | undefined) | undefined;
}

export interface DevicePostureServices {
  readonly devicePosture: DevicePostureRuntime;
}

/** Build the device posture runtime and bind the device verbs to it. */
export function createDevicePostureServices(options: DevicePostureCompositionOptions): DevicePostureServices {
  const devicePosture = createDevicePostureRuntime({
    transport: options.distributedRuntime,
    approvals: options.approvals,
    config: options.configManager,
    stateDirectory: options.stateDirectory,
    actor: TUI_DEVICE_ACTOR,
    ...(options.getSessionId ? { getSessionId: options.getSessionId } : {}),
  });
  if (options.gatewayMethods) registerDevicesGatewayMethods(options.gatewayMethods, devicePosture);
  return { devicePosture };
}

/**
 * Everything a host with a tool registry has to do once it is up: register the
 * `phone` tool — the only path that reaches the capability service, so without it
 * the posture keys govern nothing a session can observe — and start housekeeping.
 *
 * One call, because these two belong to the same feature and a host that did the
 * first and forgot the second would serve requests while never reaping a grant
 * whose phone is gone.
 */
export function installDevicePosture(
  toolRegistry: DevicePhoneToolRegistry,
  devicePosture: DevicePostureRuntime,
): void {
  registerDevicePhoneTool(toolRegistry, devicePosture);
  startDeviceHousekeeping(devicePosture);
}

/**
 * The recovery sweep plus the periodic timer. Separate from construction so
 * composing a runtime in a test starts no timer and touches no disk, and
 * separate from the call above so the standalone daemon — which registers no
 * tools — still sweeps.
 */
export function startDeviceHousekeeping(devicePosture: DevicePostureRuntime): void {
  void devicePosture.startHousekeeping().catch((error: unknown) => {
    logger.warn('Device housekeeping sweep failed at startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
