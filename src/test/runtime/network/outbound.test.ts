import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import {
  applyOutboundTlsToFetchInit,
  createNetworkFetch,
  inspectOutboundTls,
} from '@/runtime/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

describe('runtime/network outbound TLS', () => {
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-network-outbound-'));
    configDir = join(root, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('defaults to Bun bundled trust roots', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
    const snapshot = inspectOutboundTls(config);
    expect(snapshot.mode).toBe('bundled');
    expect(snapshot.effectiveCaStrategy).toBe('bun-default');
    expect(snapshot.customCaEntryCount).toBe(0);
  });

  test('merges bundled roots with custom CA files when requested', () => {
    const certDir = join(root, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const caPath = join(certDir, 'corp-root.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n', 'utf-8');
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
    config.set('network.outboundTls.mode', 'bundled+custom');
    config.set('network.outboundTls.customCaFile', caPath);

    const init = applyOutboundTlsToFetchInit('https://api.example.test', {}, config);

    const tls = (init as RequestInit & { tls?: { ca?: unknown } }).tls;
    expect(Array.isArray(tls?.ca)).toBe(true);
    expect((tls?.ca as unknown[]).length).toBeGreaterThan(1);
  });

  test('throws when custom-only trust is enabled without any CA material', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
    config.set('network.outboundTls.mode', 'custom');

    expect(() => applyOutboundTlsToFetchInit('https://api.example.test', {}, config)).toThrow(/custom CA/i);
  });

  test('allows insecure localhost only for loopback HTTPS targets', () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
    config.set('network.outboundTls.allowInsecureLocalhost', true);

    const localInit = applyOutboundTlsToFetchInit('https://127.0.0.1:8443', {}, config);
    const remoteInit = applyOutboundTlsToFetchInit('https://api.example.test', {}, config);

    expect((localInit as RequestInit & { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized).toBe(false);
    expect((remoteInit as RequestInit & { tls?: { rejectUnauthorized?: boolean } }).tls?.rejectUnauthorized).toBeUndefined();
  });

  test('wraps fetch and injects resolved TLS options', async () => {
    const certDir = join(root, '.goodvibes', 'tui', 'certs');
    mkdirSync(certDir, { recursive: true });
    const caPath = join(certDir, 'internal.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n', 'utf-8');
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
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

  test('emits provider egress trace for chat completions', async () => {
    const config = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: root });
    const debugSpy = spyOn(logger, 'debug');
    const fetchImpl = mock(async () => new Response('ok', {
      status: 200,
      headers: { 'x-request-id': 'req-egress-1' },
    })) as unknown as typeof globalThis.fetch;

    try {
      const wrappedFetch = createNetworkFetch(fetchImpl, config);
      await wrappedFetch('https://api.inceptionlabs.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

      const requestCall = debugSpy.mock.calls.find(([message]) => message === 'Outbound provider request');
      const responseCall = debugSpy.mock.calls.find(([message]) => message === 'Outbound provider response');

      expect(requestCall?.[1]).toMatchObject({
        method: 'POST',
        host: 'api.inceptionlabs.ai',
        path: '/v1/chat/completions',
        contentType: 'application/json',
      });
      expect(responseCall?.[1]).toMatchObject({
        method: 'POST',
        host: 'api.inceptionlabs.ai',
        path: '/v1/chat/completions',
        status: 200,
        requestId: 'req-egress-1',
      });
    } finally {
      debugSpy.mockRestore();
    }
  });
});
