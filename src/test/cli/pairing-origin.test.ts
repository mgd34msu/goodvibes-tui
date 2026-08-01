import { describe, test, expect } from 'bun:test';
import { resolvePairingWebOrigin, ensurePublicBaseUrl, isHttpOnLan } from '@pellux/goodvibes-sdk/platform/pairing';
import type { StableHostInputs } from '@pellux/goodvibes-sdk/platform/pairing';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

/**
 * Minimal config double: a map of keys to values, plus a setDynamic recorder.
 *
 * `get` is cast through `unknown` straight to ConfigManager's own method type
 * (rather than reconstructed as an independent generic signature): the SDK's
 * ConfigValue mapped type is a very large discriminated union, and asking the
 * compiler to structurally verify a freshly-written `get<K extends
 * ConfigKey>` against it here hits TS's "excessive stack depth" recursion
 * limit (TS2321) — a compiler limitation, not a real type mismatch.
 */
function fakeConfig(initial: Record<string, unknown>) {
  const store = { ...initial };
  const writes: Array<[string, unknown]> = [];
  return {
    store,
    writes,
    get: ((key: string) => store[key]) as unknown as ConfigManager['get'],
    setDynamic: (key: ConfigKey, value: unknown) => {
      store[key] = value;
      writes.push([key, value]);
    },
  };
}

const stableProbe = (): StableHostInputs => ({ hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42' });
const unstableProbe = (): StableHostInputs => ({ hostname: 'localhost', gatewayInterfaceIp: '192.168.1.42' });

describe('resolvePairingWebOrigin', () => {
  test('a user-set web.publicBaseUrl is authoritative and never re-derived', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'https://vibes.example/' });
    const resolved = resolvePairingWebOrigin(cfg, stableProbe);
    expect(resolved.origin).toBe('https://vibes.example'); // trailing slash trimmed
    expect(resolved.fromPublicBaseUrl).toBe(true);
    expect(resolved.httpOnLan).toBe(false); // https
  });

  test('empty publicBaseUrl derives http://<stable-host>:<web-port>', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = resolvePairingWebOrigin(cfg, stableProbe);
    expect(resolved.origin).toBe('http://workshop.local:3141');
    expect(resolved.fromPublicBaseUrl).toBe(false);
    expect(resolved.httpOnLan).toBe(true);
  });
});

describe('ensurePublicBaseUrl', () => {
  test('persists the derived origin once when a stable name exists', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = ensurePublicBaseUrl(cfg, stableProbe);
    expect(resolved.origin).toBe('http://workshop.local:3141');
    expect(cfg.writes).toEqual([['web.publicBaseUrl', 'http://workshop.local:3141']]);
    // Idempotent: a second call sees the now-set value and does not write again.
    const again = ensurePublicBaseUrl(cfg, stableProbe);
    expect(again.fromPublicBaseUrl).toBe(true);
    expect(cfg.writes).toHaveLength(1);
  });

  test('does NOT freeze a DHCP-bound address into config', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = ensurePublicBaseUrl(cfg, unstableProbe);
    expect(resolved.origin).toBe('http://192.168.1.42:3141');
    expect(cfg.writes).toEqual([]); // unstable ⇒ not persisted
  });

  test('never clobbers a user-set value', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'https://mine.example' });
    ensurePublicBaseUrl(cfg, stableProbe);
    expect(cfg.writes).toEqual([]);
    expect(cfg.store['web.publicBaseUrl']).toBe('https://mine.example');
  });
});

describe('isHttpOnLan', () => {
  test.each([
    ['http://workshop.local:3141', true],
    ['http://192.168.1.5:3141', true],
    ['http://127.0.0.1:3141', false],
    ['http://localhost:3141', false],
    ['https://app.example', false],
  ])('%s -> %p', (origin, expected) => {
    expect(isHttpOnLan(origin as string)).toBe(expected);
  });
});
