import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../../../config/manager.ts';
import {
  applyOutboundTlsToFetchInit,
  createNetworkFetch,
  inspectOutboundTls,
  resetGlobalNetworkTransportForTesting,
} from '../../../runtime/network/index.ts';

describe('runtime/network outbound TLS', () => {
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-network-outbound-'));
    configDir = join(root, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    ConfigManager.setTestMode(configDir);
    resetGlobalNetworkTransportForTesting();
  });

  afterEach(() => {
    resetGlobalNetworkTransportForTesting();
    ConfigManager.setTestMode(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  test('defaults to Bun bundled trust roots', () => {
    const config = new ConfigManager();
    const snapshot = inspectOutboundTls(config);
    expect(snapshot.mode).toBe('bundled');
    expect(snapshot.effectiveCaStrategy).toBe('bun-default');
    expect(snapshot.customCaEntryCount).toBe(0);
  });

  test('merges bundled roots with custom CA files when requested', () => {
    const certDir = join(root, '.goodvibes', 'certs');
    mkdirSync(certDir, { recursive: true });
    const caPath = join(certDir, 'corp-root.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n', 'utf-8');
    const config = new ConfigManager();
    config.set('network.outboundTls.mode', 'bundled+custom');
    config.set('network.outboundTls.customCaFile', caPath);

    const init = applyOutboundTlsToFetchInit('https://api.example.test', {}, config);

    const tls = (init as RequestInit & { tls?: { ca?: unknown } }).tls;
    expect(Array.isArray(tls?.ca)).toBe(true);
    expect((tls?.ca as unknown[]).length).toBeGreaterThan(1);
  });

  test('throws when custom-only trust is enabled without any CA material', () => {
    const config = new ConfigManager();
    config.set('network.outboundTls.mode', 'custom');

    expect(() => applyOutboundTlsToFetchInit('https://api.example.test', {}, config)).toThrow(/custom CA/i);
  });

  test('allows insecure localhost only for loopback HTTPS targets', () => {
    const config = new ConfigManager();
    config.set('network.outboundTls.allowInsecureLocalhost', true);

    const localInit = applyOutboundTlsToFetchInit('https://127.0.0.1:8443', {}, config);
    const remoteInit = applyOutboundTlsToFetchInit('https://api.example.test', {}, config);

    expect((localInit as RequestInit & { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized).toBe(false);
    expect((remoteInit as RequestInit & { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized).toBeUndefined();
  });

  test('wraps fetch and injects resolved TLS options', async () => {
    const certDir = join(root, '.goodvibes', 'certs');
    mkdirSync(certDir, { recursive: true });
    const caPath = join(certDir, 'internal.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n', 'utf-8');
    const config = new ConfigManager();
    config.set('network.outboundTls.mode', 'custom');
    config.set('network.outboundTls.customCaFile', caPath);
    const calls: Array<RequestInit & { tls?: { ca?: unknown } }> = [];
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push((init ?? {}) as RequestInit & { tls?: { ca?: unknown } });
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;

    const wrappedFetch = createNetworkFetch(fetchImpl, config);
    await wrappedFetch('https://api.example.test');

    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]?.tls?.ca)).toBe(true);
    expect((calls[0]?.tls?.ca as unknown[]).length).toBe(1);
  });
});
