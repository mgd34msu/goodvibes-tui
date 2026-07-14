/**
 * stable-host.ts — a stable name for printed/QR pairing links.
 *
 * The legacy resolution used the first non-internal IPv4 in enumeration order
 * (see getLocalNetworkIp in management-utils.ts). That address is bound to the
 * current DHCP lease: when the lease changes, every printed link and every QR
 * that encoded it stops resolving. This module resolves a name that survives a
 * lease change where one exists, and only falls back to a routable address when
 * no stable name is available.
 *
 * Resolution ladder (highest preference first):
 *   1. Tailscale MagicDNS name — preferred when tailscale is up. It resolves on
 *      and off the LAN and is never bound to a DHCP lease.
 *   2. mDNS `<hostname>.local` — a LAN name a DHCP change does not break.
 *   3. Gateway-routed interface address — the IPv4 on the default-route
 *      interface (not merely the first non-internal one, which can land on a
 *      bridge/VPN). The last resort; DHCP-bound.
 *   4. Loopback — nothing routable enumerated.
 *
 * The resolver (resolveStableHost) is a pure function of injected inputs so the
 * ladder is testable under mocked interface / tailscale states; the probes that
 * gather those inputs are impure and bounded, and degrade to undefined rather
 * than throw when a tool is missing or slow.
 */
import { execFileSync } from 'node:child_process';
import { hostname as osHostname, networkInterfaces } from 'node:os';

export type StableHostKind = 'tailscale-magicdns' | 'mdns-local' | 'gateway-interface' | 'loopback';

export interface TailscaleState {
  /** BackendState === 'Running'. */
  readonly up: boolean;
  /** Self.DNSName from `tailscale status --json`, trailing dot stripped. */
  readonly magicDnsName?: string | undefined;
}

export interface StableHostInputs {
  /** os.hostname(), possibly an FQDN — the `.local` name derives from its first label. */
  readonly hostname: string;
  /** The routable IPv4 on the default-route interface, when known. */
  readonly gatewayInterfaceIp?: string | undefined;
  /** First non-internal IPv4 in enumeration order — the legacy fallback address. */
  readonly firstNonInternalIp?: string | undefined;
  /** Tailscale state, when the CLI is present and answered in time. */
  readonly tailscale?: TailscaleState | undefined;
}

export interface ResolvedStableHost {
  readonly host: string;
  readonly kind: StableHostKind;
  /** True when `host` is a name that survives a DHCP lease change. */
  readonly stable: boolean;
}

function stripTrailingDot(name: string): string {
  return name.replace(/\.+$/, '');
}

/** `<hostname>.local` from the first label of a hostname, or null when there is no usable label. */
export function mdnsLocalName(host: string): string | null {
  const label = (host ?? '').trim().split('.')[0]?.trim();
  if (!label || label.toLowerCase() === 'localhost') return null;
  // Already a `.local` name (hostname was set to the mDNS form): keep it as-is.
  if (host.trim().toLowerCase().endsWith('.local')) return stripTrailingDot(host.trim());
  return `${label}.local`;
}

/**
 * Resolve the stable host from injected inputs. Pure — no I/O — so the ladder is
 * exercised directly under mocked interface / tailscale states.
 */
export function resolveStableHost(inputs: StableHostInputs): ResolvedStableHost {
  const magic = inputs.tailscale?.up ? inputs.tailscale.magicDnsName?.trim() : undefined;
  if (magic) return { host: stripTrailingDot(magic), kind: 'tailscale-magicdns', stable: true };

  const local = mdnsLocalName(inputs.hostname);
  if (local) return { host: local, kind: 'mdns-local', stable: true };

  const routed = inputs.gatewayInterfaceIp?.trim() || inputs.firstNonInternalIp?.trim();
  if (routed) return { host: routed, kind: 'gateway-interface', stable: false };

  return { host: '127.0.0.1', kind: 'loopback', stable: false };
}

/** First non-internal IPv4 in enumeration order (the legacy fallback address). */
export function firstNonInternalIpv4(nets: ReturnType<typeof networkInterfaces>): string | undefined {
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] ?? []) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
    }
  }
  return undefined;
}

/** Parse the `src <ip>` field out of a Linux `ip route get` line. */
export function parseIpRouteSrc(output: string): string | undefined {
  const match = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(output);
  return match?.[1];
}

/** Parse `Self.DNSName` + running state out of `tailscale status --json` output. */
export function parseTailscaleStatus(json: string): TailscaleState | undefined {
  try {
    const parsed = JSON.parse(json) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const up = parsed.BackendState === 'Running';
    const dnsName = typeof parsed.Self?.DNSName === 'string' ? stripTrailingDot(parsed.Self.DNSName) : undefined;
    return { up, ...(dnsName ? { magicDnsName: dnsName } : {}) };
  } catch {
    return undefined;
  }
}

function probeGatewayInterfaceIp(): string | undefined {
  try {
    const out = execFileSync('ip', ['route', 'get', '1.1.1.1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
    return parseIpRouteSrc(out);
  } catch {
    return undefined;
  }
}

function probeTailscaleState(): TailscaleState | undefined {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
    return parseTailscaleStatus(out);
  } catch {
    return undefined;
  }
}

/** Gather the impure inputs the resolver needs, each bounded and failure-tolerant. */
export function probeStableHostInputs(): StableHostInputs {
  let nets: ReturnType<typeof networkInterfaces> = {};
  try {
    nets = networkInterfaces();
  } catch {
    nets = {};
  }
  const first = firstNonInternalIpv4(nets);
  const gateway = probeGatewayInterfaceIp();
  const tailscale = probeTailscaleState();
  return {
    hostname: safeHostname(),
    ...(gateway ? { gatewayInterfaceIp: gateway } : {}),
    ...(first ? { firstNonInternalIp: first } : {}),
    ...(tailscale ? { tailscale } : {}),
  };
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return '';
  }
}

/**
 * The stable host for a printed/QR link given the endpoint's bind host. A
 * wildcard bind (0.0.0.0 / ::) resolves through the ladder; an explicit bind
 * host is honored as-is (loopback stays loopback). `probe` is injectable for
 * tests.
 */
export function stableUrlHostForBindHost(
  host: string,
  probe: () => StableHostInputs = probeStableHostInputs,
): ResolvedStableHost {
  if (host === '0.0.0.0' || host === '::') return resolveStableHost(probe());
  const bound = host || '127.0.0.1';
  return { host: bound, kind: bound === '127.0.0.1' ? 'loopback' : 'gateway-interface', stable: false };
}
