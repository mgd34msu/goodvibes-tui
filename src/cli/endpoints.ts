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
  // Mirror the SDK bind path exactly (`Number(raw ?? default)` fed into
  // `customPort || DEFAULT` in host-resolver.js): a stored 0 OR a non-numeric
  // value both collapse to the endpoint default, never NaN — so anything
  // displayed from this binding matches the port the server actually binds.
  const port = Number(config.get(keys.port) ?? RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint]) || RUNTIME_ENDPOINT_DEFAULT_PORTS[endpoint];
  if (hostMode === 'network') {
    return { hostMode, configuredHost, host: '0.0.0.0', port };
  }
  if (hostMode === 'custom') {
    return { hostMode, configuredHost, host: configuredHost || '127.0.0.1', port };
  }
  return { hostMode, configuredHost, host: '127.0.0.1', port };
}
