import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { ConfigManager } from '../../../config/manager.ts';
import { inspectInboundTls } from '../../../runtime/network/index.ts';

describe('runtime/network inbound TLS', () => {
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-network-inbound-'));
    configDir = join(root, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    ConfigManager.setTestMode(configDir);
  });

  afterEach(() => {
    ConfigManager.setTestMode(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  test('uses ~/.goodvibes/certs-style defaults for direct control-plane TLS', () => {
    const certDir = join(root, '.goodvibes', 'certs');
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, 'fullchain.pem'), 'CERT\n', 'utf-8');
    writeFileSync(join(certDir, 'privkey.pem'), 'KEY\n', 'utf-8');
    const config = new ConfigManager();
    config.set('controlPlane.tls.mode', 'direct');

    const snapshot = inspectInboundTls(config, 'controlPlane');

    expect(snapshot.mode).toBe('direct');
    expect(snapshot.scheme).toBe('https');
    expect(snapshot.ready).toBe(true);
    expect(snapshot.usingDefaultPaths).toBe(true);
    expect(snapshot.certFile).toBe(join(certDir, 'fullchain.pem'));
    expect(snapshot.keyFile).toBe(join(certDir, 'privkey.pem'));
  });

  test('reports proxy mode without requiring local certs', () => {
    const config = new ConfigManager();
    config.set('controlPlane.tls.mode', 'proxy');
    config.set('controlPlane.trustProxy', true);

    const snapshot = inspectInboundTls(config, 'controlPlane');

    expect(snapshot.mode).toBe('proxy');
    expect(snapshot.scheme).toBe('https');
    expect(snapshot.ready).toBe(true);
    expect(snapshot.trustProxy).toBe(true);
    expect(snapshot.certFile).toBeUndefined();
  });

  test('checks private key permissions when direct listener TLS is enabled', () => {
    const certDir = join(root, '.goodvibes', 'certs');
    mkdirSync(certDir, { recursive: true });
    const certFile = join(certDir, 'listener.pem');
    const keyFile = join(certDir, 'listener-key.pem');
    writeFileSync(certFile, 'CERT\n', 'utf-8');
    writeFileSync(keyFile, 'KEY\n', 'utf-8');
    if (process.platform !== 'win32') chmodSync(keyFile, 0o644);
    const config = new ConfigManager();
    config.set('httpListener.tls.mode', 'direct');
    config.set('httpListener.tls.certFile', certFile);
    config.set('httpListener.tls.keyFile', keyFile);

    const snapshot = inspectInboundTls(config, 'httpListener');

    expect(snapshot.ready).toBe(true);
    expect(snapshot.certFile).toBe(certFile);
    expect(snapshot.keyFile).toBe(keyFile);
    if (process.platform !== 'win32') {
      expect(snapshot.keyPermissions?.available).toBe(true);
      expect(snapshot.keyPermissions?.safe).toBe(false);
      expect(snapshot.keyPermissions?.mode).toBe('0644');
    }
  });
});
