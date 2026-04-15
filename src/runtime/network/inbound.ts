import { existsSync } from 'node:fs';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { getDefaultInboundCertPaths, inspectPrivateKeyPermissions, resolvePathFromGoodVibesRoot } from '@pellux/goodvibes-sdk/platform/runtime/network/shared';

export type InboundTlsMode = 'off' | 'proxy' | 'direct';
export type InboundServerSurface = 'controlPlane' | 'httpListener';

export interface InboundTlsSnapshot {
  readonly surface: InboundServerSurface;
  readonly host: string;
  readonly port: number;
  readonly mode: InboundTlsMode;
  readonly scheme: 'http' | 'https';
  readonly trustProxy: boolean;
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly usingDefaultPaths: boolean;
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly keyPermissions?: {
    readonly available: boolean;
    readonly safe?: boolean;
    readonly mode?: string;
  };
}

export interface ResolvedInboundTlsContext extends InboundTlsSnapshot {
  readonly tls?: Bun.TLSOptions;
}

function readMode(configManager: ConfigManager, surface: InboundServerSurface): InboundTlsMode {
  return surface === 'controlPlane'
    ? configManager.get('controlPlane.tls.mode')
    : configManager.get('httpListener.tls.mode');
}

function readTrustProxy(configManager: ConfigManager, surface: InboundServerSurface): boolean {
  return surface === 'controlPlane'
    ? Boolean(configManager.get('controlPlane.trustProxy'))
    : Boolean(configManager.get('httpListener.trustProxy'));
}

function readHost(configManager: ConfigManager, surface: InboundServerSurface): string {
  return String(surface === 'controlPlane'
    ? configManager.get('controlPlane.host')
    : configManager.get('httpListener.host'));
}

function readPort(configManager: ConfigManager, surface: InboundServerSurface): number {
  return Number(surface === 'controlPlane'
    ? configManager.get('controlPlane.port')
    : configManager.get('httpListener.port'));
}

function readConfiguredCertPath(configManager: ConfigManager, surface: InboundServerSurface): string | null {
  return resolvePathFromGoodVibesRoot(
    surface === 'controlPlane'
      ? configManager.get('controlPlane.tls.certFile')
      : configManager.get('httpListener.tls.certFile'),
    configManager,
  );
}

function readConfiguredKeyPath(configManager: ConfigManager, surface: InboundServerSurface): string | null {
  return resolvePathFromGoodVibesRoot(
    surface === 'controlPlane'
      ? configManager.get('controlPlane.tls.keyFile')
      : configManager.get('httpListener.tls.keyFile'),
    configManager,
  );
}

export function inspectInboundTls(configManager: ConfigManager, surface: InboundServerSurface): InboundTlsSnapshot {
  const mode = readMode(configManager, surface);
  const trustProxy = readTrustProxy(configManager, surface);
  const host = readHost(configManager, surface);
  const port = readPort(configManager, surface);
  if (mode !== 'direct') {
    return {
      surface,
      host,
      port,
      mode,
      scheme: mode === 'proxy' ? 'https' : 'http',
      trustProxy,
      usingDefaultPaths: false,
      ready: true,
      errors: [],
    };
  }

  const defaults = getDefaultInboundCertPaths(configManager);
  const certFile = readConfiguredCertPath(configManager, surface) ?? defaults.certFile;
  const keyFile = readConfiguredKeyPath(configManager, surface) ?? defaults.keyFile;
  const usingDefaultPaths = certFile === defaults.certFile && keyFile === defaults.keyFile;
  const errors: string[] = [];
  if (!existsSync(certFile)) errors.push(`Certificate file not found: ${certFile}`);
  if (!existsSync(keyFile)) errors.push(`Private key file not found: ${keyFile}`);
  const keyPermissions = inspectPrivateKeyPermissions(keyFile);
  return {
    surface,
    host,
    port,
    mode,
    scheme: 'https',
    trustProxy,
    certFile,
    keyFile,
    usingDefaultPaths,
    ready: errors.length === 0,
    errors,
    keyPermissions,
  };
}

export function resolveInboundTlsContext(configManager: ConfigManager, surface: InboundServerSurface): ResolvedInboundTlsContext {
  const snapshot = inspectInboundTls(configManager, surface);
  if (snapshot.mode !== 'direct') return snapshot;
  if (!snapshot.ready || !snapshot.certFile || !snapshot.keyFile) {
    throw new Error(
      `${surface} direct TLS is enabled but certificate files are not ready: ${snapshot.errors.join('; ')}`,
    );
  }
  return {
    ...snapshot,
    tls: {
      cert: Bun.file(snapshot.certFile),
      key: Bun.file(snapshot.keyFile),
    },
  };
}
