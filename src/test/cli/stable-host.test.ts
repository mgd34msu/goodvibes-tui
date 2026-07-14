import { describe, test, expect } from 'bun:test';
import {
  resolveStableHost,
  mdnsLocalName,
  parseIpRouteSrc,
  parseTailscaleStatus,
  firstNonInternalIpv4,
  stableUrlHostForBindHost,
  type StableHostInputs,
} from '../../cli/stable-host.ts';

describe('resolveStableHost ladder', () => {
  test('tailscale MagicDNS wins when tailscale is up', () => {
    const inputs: StableHostInputs = {
      hostname: 'workshop.lan',
      gatewayInterfaceIp: '192.168.1.42',
      firstNonInternalIp: '192.168.1.42',
      tailscale: { up: true, magicDnsName: 'workshop.tail1234.ts.net.' },
    };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.tail1234.ts.net', kind: 'tailscale-magicdns', stable: true });
  });

  test('tailscale down falls through to mDNS .local even with a MagicDNS name present', () => {
    const inputs: StableHostInputs = {
      hostname: 'workshop',
      gatewayInterfaceIp: '192.168.1.42',
      tailscale: { up: false, magicDnsName: 'workshop.tail1234.ts.net' },
    };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.local', kind: 'mdns-local', stable: true });
  });

  test('no tailscale: mDNS .local from the first hostname label', () => {
    const inputs: StableHostInputs = { hostname: 'workshop.internal.example', gatewayInterfaceIp: '10.0.0.5' };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.local', kind: 'mdns-local', stable: true });
  });

  test('no stable name: gateway-routed interface address, marked unstable', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', gatewayInterfaceIp: '10.0.0.5', firstNonInternalIp: '172.17.0.1' };
    expect(resolveStableHost(inputs)).toEqual({ host: '10.0.0.5', kind: 'gateway-interface', stable: false });
  });

  test('gateway address preferred over the first-non-internal fallback', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', gatewayInterfaceIp: '10.0.0.5', firstNonInternalIp: '172.17.0.1' };
    expect(resolveStableHost(inputs).host).toBe('10.0.0.5');
  });

  test('falls back to firstNonInternalIp when no gateway route resolved', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', firstNonInternalIp: '192.168.5.9' };
    expect(resolveStableHost(inputs)).toEqual({ host: '192.168.5.9', kind: 'gateway-interface', stable: false });
  });

  test('nothing routable: loopback', () => {
    expect(resolveStableHost({ hostname: 'localhost' })).toEqual({ host: '127.0.0.1', kind: 'loopback', stable: false });
  });

  test('a DHCP lease change does not change a resolved stable name', () => {
    const before: StableHostInputs = { hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42' };
    const after: StableHostInputs = { hostname: 'workshop', gatewayInterfaceIp: '192.168.1.77' };
    expect(resolveStableHost(before).host).toBe(resolveStableHost(after).host);
    expect(resolveStableHost(before).host).toBe('workshop.local');
  });
});

describe('mdnsLocalName', () => {
  test('localhost has no usable label', () => {
    expect(mdnsLocalName('localhost')).toBeNull();
  });
  test('already-.local hostname is kept', () => {
    expect(mdnsLocalName('workshop.local')).toBe('workshop.local');
  });
  test('empty hostname is null', () => {
    expect(mdnsLocalName('')).toBeNull();
  });
});

describe('parsers', () => {
  test('parseIpRouteSrc extracts the src address', () => {
    expect(parseIpRouteSrc('1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.42 uid 1000 \n cache')).toBe('192.168.1.42');
  });
  test('parseIpRouteSrc returns undefined when no src', () => {
    expect(parseIpRouteSrc('unreachable')).toBeUndefined();
  });
  test('parseTailscaleStatus running with DNSName', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail.ts.net.' } }))).toEqual({ up: true, magicDnsName: 'box.tail.ts.net' });
  });
  test('parseTailscaleStatus stopped', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: {} }))).toEqual({ up: false });
  });
  test('parseTailscaleStatus invalid json', () => {
    expect(parseTailscaleStatus('not json')).toBeUndefined();
  });
  test('firstNonInternalIpv4 skips internal + IPv6', () => {
    const nets = {
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never],
      eth0: [{ family: 'IPv6', internal: false, address: 'fe80::1' } as never, { family: 'IPv4', internal: false, address: '192.168.1.42' } as never],
    };
    expect(firstNonInternalIpv4(nets)).toBe('192.168.1.42');
  });
});

describe('stableUrlHostForBindHost', () => {
  const probe = (): StableHostInputs => ({ hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42' });
  test('wildcard bind resolves through the ladder', () => {
    expect(stableUrlHostForBindHost('0.0.0.0', probe).host).toBe('workshop.local');
    expect(stableUrlHostForBindHost('::', probe).host).toBe('workshop.local');
  });
  test('explicit bind host is honored as-is', () => {
    expect(stableUrlHostForBindHost('10.0.0.9', probe)).toEqual({ host: '10.0.0.9', kind: 'gateway-interface', stable: false });
  });
  test('loopback stays loopback', () => {
    expect(stableUrlHostForBindHost('127.0.0.1', probe)).toEqual({ host: '127.0.0.1', kind: 'loopback', stable: false });
  });
});
