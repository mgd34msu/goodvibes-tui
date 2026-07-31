import { resolveWebPort } from '@pellux/goodvibes-sdk/platform/daemon';
import type { ConfigKey, ConfigManager } from '../config/index.ts';

export type RuntimeEndpointId = 'controlPlane' | 'httpListener' | 'web';
export type RuntimeHostMode = 'local' | 'network' | 'custom';

export const RUNTIME_ENDPOINT_DEFAULT_PORTS: Record<RuntimeEndpointId, number> = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
};

export const RUNTIME_ENDPOINT_CONFIG_KEYS: Record<RuntimeEndpointId, {
  readonly hostMode: ConfigKey;
  readonly host: ConfigKey;
  readonly port: ConfigKey;
}> = {
  controlPlane: {
    hostMode: 'controlPlane.hostMode',
    host: 'controlPlane.host',
    port: 'controlPlane.port',
  },
  httpListener: {
    hostMode: 'httpListener.hostMode',
    host: 'httpListener.host',
    port: 'httpListener.port',
  },
  web: {
    hostMode: 'web.hostMode',
    host: 'web.host',
    port: 'web.port',
  },
};

export interface RuntimeEndpointBinding {
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  /**
   * False when the stored hostMode is not one of the SDK's recognized modes
   * ('local' | 'network' | 'custom'). The SDK's resolveHostBinding is a switch
   * with NO default case: an unrecognized mode yields an undefined binding and
   * the daemon throws in its constructor before ever binding. Displays must
   * therefore never present the host/port below as a definite binding when
   * this is false — the fallback values exist only so display code has
   * something structured to show alongside the warning.
   */
  readonly recognized: boolean;
}

/**
 * THE one display seam for endpoint bindings: every surface that renders a
 * binding as text goes through this, so no surface can present the resolver's
 * loopback fallback as a definite bind for a hostMode the SDK cannot handle
 * (its bind resolver has no default case — the daemon throws before binding).
 * The recognized case renders the familiar `<mode> <host>:<port>`.
 */
export function formatRuntimeEndpointBinding(binding: RuntimeEndpointBinding): string {
  if (binding.recognized) {
    return `${binding.hostMode} ${binding.host}:${binding.port}`;
  }
  return `'${binding.hostMode}' — not a recognized host mode (expected local|network|custom); the daemon cannot bind this endpoint until it is corrected`;
}

export function hostModeForHostname(hostname: string): RuntimeHostMode {
  const normalized = hostname.toLowerCase();
  if (normalized === '0.0.0.0' || normalized === '::') return 'network';
  if (normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1') return 'local';
  return 'custom';
}

export function resolveRuntimeEndpointBinding(
  config: Pick<ConfigManager, 'get'>,
  endpoint: RuntimeEndpointId,
): RuntimeEndpointBinding {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const hostMode = String(config.get(keys.hostMode) ?? 'local');
  const configuredHost = String(config.get(keys.host) ?? '127.0.0.1');
  // Port coercion is anchored PER ENDPOINT to what the SDK actually does with
  // the stored value, so a display never disagrees with the machinery:
  //   - controlPlane / httpListener bind via resolveHostBinding, which is fed
  //     `Number(raw ?? default)` and applies `customPort || DEFAULT` — a
  //     stored 0 or non-numeric value collapses to the endpoint default.
  //   - web goes through the SDK's own resolveWebPort. This used to be a copy
  //     of what that function did when it was a bare `Number(raw ?? default)`,
  //     with a note saying a proper resolver was an SDK-side fix. The SDK has
  //     one now — resolveWebBinding, which surface announcements, channel
  //     account links and tailscale-serve all anchor to — so the copy would now
  //     be the thing making the display disagree with the machinery.
  const rawPort = Number(config.get(keys.port) ?? RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]);
  const port = endpoint === 'web'
    ? resolveWebPort(config.get(keys.port))
    : (rawPort || RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]);
  if (hostMode === 'network') {
    return { hostMode, configuredHost, host: '0.0.0.0', port, recognized: true };
  }
  if (hostMode === 'custom') {
    return { hostMode, configuredHost, host: configuredHost || '127.0.0.1', port, recognized: true };
  }
  if (hostMode === 'local') {
    return { hostMode, configuredHost, host: '127.0.0.1', port, recognized: true };
  }
  // Unrecognized hostMode ('LAN', 'Network', '', a trimmed variant, …): the
  // SDK bind path has NO default case for this — resolveHostBinding returns
  // undefined and the daemon throws before binding. There IS no real binding
  // to display; recognized:false tells callers to warn instead of asserting
  // the loopback fallback below as fact.
  return { hostMode, configuredHost, host: '127.0.0.1', port, recognized: false };
}
