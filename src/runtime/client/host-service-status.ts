/**
 * host-service-status.ts, reading a background service's posture.
 *
 * Three questions the composition root asks about the daemon and the webhook
 * listener, none of which need anything from the composition itself: what URL
 * a configured host/port is reachable at, what to report before the discovery
 * probe has finished, and whether a given verdict means "usable" or "the port
 * is held and this terminal cannot have it".
 */

import type { HostServiceStatus } from '@/runtime/index.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/** Which of the two background services a question is about. */
export type HostServiceName = 'daemon' | 'httpListener';

/**
 * The URL a configured host/port is actually reachable at. A wildcard bind is
 * not an address anything can connect to, so `0.0.0.0` and `::` resolve to the
 * loopback address of their family; a bare IPv6 literal is bracketed.
 */
export function formatHostServiceBaseUrl(host: string, port: number): string {
  const normalized = host.trim().toLowerCase();
  const probeHost = normalized === '0.0.0.0'
    ? '127.0.0.1'
    : normalized === '::' || normalized === '[::]'
      ? '::1'
      : host;
  const urlHost = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
  return `http://${urlHost}:${port}`;
}

/**
 * What to report about a service before the discovery probe has answered:
 * where it WOULD be, and the honest reason nothing is known about it yet.
 */
export function createPendingServiceStatus(
  configManager: Pick<ConfigManager, 'get'>,
  service: HostServiceName,
): HostServiceStatus {
  const host = String(configManager.get(service === 'daemon' ? 'controlPlane.host' : 'httpListener.host') ?? '127.0.0.1');
  const port = Number(configManager.get(service === 'daemon' ? 'controlPlane.port' : 'httpListener.port') ?? (service === 'daemon' ? 3421 : 3422));
  return {
    mode: 'unavailable',
    host,
    port,
    baseUrl: formatHostServiceBaseUrl(host, port),
    reason: 'Background service startup has not completed yet',
  };
}

/**
 * A service this terminal can actually use. Called for both the daemon and the
 * HTTP listener (see bootstrap.ts), so the 'embedded' arm stays live: the SDK
 * always reports its in-process HTTP listener as 'embedded', even though this
 * product's daemon status can never carry that mode (adoptOnly is hardcoded on
 * every host-services call this app makes).
 */
export function hostServiceIsActive(status: HostServiceStatus): boolean {
  return status.mode === 'embedded' || status.mode === 'external';
}

/**
 * The configured port is held and unusable by this terminal, either by an
 * unverified process ('blocked') or by a GoodVibes daemon this build refused to
 * adopt ('incompatible': a wire-version mismatch, or a daemon below this
 * build's own floor).
 */
export function hostServiceIsBlocked(status: HostServiceStatus): boolean {
  return status.mode === 'blocked' || status.mode === 'incompatible';
}
