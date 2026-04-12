import { existsSync, readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';
import type { ConfigManager } from '../../config/manager.ts';
import { logger } from '../../utils/logger.ts';
import { isLocalHostname, readPemEntriesFromDirectory, resolvePathFromGoodVibesRoot } from './shared.ts';

export type OutboundTrustMode = 'bundled' | 'bundled+custom' | 'custom';

type FetchTlsOptions = Bun.TLSOptions & {
  checkServerIdentity?: NonNullable<import('node:tls').ConnectionOptions['checkServerIdentity']>;
};

type FetchInitWithTls = RequestInit & {
  tls?: FetchTlsOptions;
};

export interface OutboundTlsSnapshot {
  readonly mode: OutboundTrustMode;
  readonly allowInsecureLocalhost: boolean;
  readonly customCaFile?: string;
  readonly customCaDir?: string;
  readonly customCaEntryCount: number;
  readonly effectiveCaStrategy: 'bun-default' | 'bundled+custom' | 'custom';
  readonly errors: readonly string[];
}

interface ResolvedOutboundTlsContext {
  readonly snapshot: OutboundTlsSnapshot;
  readonly caEntries?: readonly string[];
}

const NETWORK_FETCH_WRAPPER = Symbol.for('goodvibes.network.fetch-wrapper');
const NETWORK_FETCH_MANAGER = Symbol.for('goodvibes.network.fetch-manager');

type WrappedNetworkFetch = typeof globalThis.fetch & {
  [NETWORK_FETCH_WRAPPER]?: true;
  [NETWORK_FETCH_MANAGER]?: GlobalNetworkTransportInstaller;
};

function readMode(configManager: ConfigManager): OutboundTrustMode {
  return configManager.get('network.outboundTls.mode');
}

function readAllowInsecureLocalhost(configManager: ConfigManager): boolean {
  return Boolean(configManager.get('network.outboundTls.allowInsecureLocalhost'));
}

function readCustomCaFile(configManager: ConfigManager): string | null {
  return resolvePathFromGoodVibesRoot(configManager.get('network.outboundTls.customCaFile'), configManager);
}

function readCustomCaDir(configManager: ConfigManager): string | null {
  return resolvePathFromGoodVibesRoot(configManager.get('network.outboundTls.customCaDir'), configManager);
}

function loadCustomCaEntries(configManager: ConfigManager): {
  readonly entries: readonly string[];
  readonly errors: readonly string[];
  readonly customCaFile?: string;
  readonly customCaDir?: string;
} {
  const errors: string[] = [];
  const entries: string[] = [];
  const customCaFile = readCustomCaFile(configManager);
  const customCaDir = readCustomCaDir(configManager);

  if (customCaFile) {
    if (existsSync(customCaFile)) {
      entries.push(readFileSync(customCaFile, 'utf-8'));
    } else {
      errors.push(`Custom CA file not found: ${customCaFile}`);
    }
  }

  if (customCaDir) {
    if (existsSync(customCaDir)) {
      for (const path of readPemEntriesFromDirectory(customCaDir)) {
        entries.push(readFileSync(path, 'utf-8'));
      }
    } else {
      errors.push(`Custom CA directory not found: ${customCaDir}`);
    }
  }

  return {
    entries,
    errors,
    ...(customCaFile ? { customCaFile } : {}),
    ...(customCaDir ? { customCaDir } : {}),
  };
}

function getBundledCaEntries(): readonly string[] {
  return getCACertificates('bundled');
}

export function inspectOutboundTls(configManager: ConfigManager): OutboundTlsSnapshot {
  const mode = readMode(configManager);
  const allowInsecureLocalhost = readAllowInsecureLocalhost(configManager);
  const custom = loadCustomCaEntries(configManager);
  return {
    mode,
    allowInsecureLocalhost,
    ...(custom.customCaFile ? { customCaFile: custom.customCaFile } : {}),
    ...(custom.customCaDir ? { customCaDir: custom.customCaDir } : {}),
    customCaEntryCount: custom.entries.length,
    effectiveCaStrategy: mode === 'bundled'
      ? 'bun-default'
      : mode === 'bundled+custom'
        ? 'bundled+custom'
        : 'custom',
    errors: custom.errors,
  };
}

function resolveOutboundTlsContext(configManager: ConfigManager): ResolvedOutboundTlsContext {
  const snapshot = inspectOutboundTls(configManager);
  const custom = loadCustomCaEntries(configManager);
  const caEntries = snapshot.mode === 'bundled'
    ? undefined
    : snapshot.mode === 'bundled+custom'
      ? [...getBundledCaEntries(), ...custom.entries]
      : [...custom.entries];
  return { snapshot, ...(caEntries ? { caEntries } : {}) };
}

function extractRequestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url);
    return null;
  } catch {
    return null;
  }
}

export function applyOutboundTlsToFetchInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  configManager: ConfigManager,
): FetchInitWithTls {
  const url = extractRequestUrl(input);
  const nextInit = { ...(init ?? {}) } as FetchInitWithTls;
  if (!url || url.protocol !== 'https:') return nextInit;

  const context = resolveOutboundTlsContext(configManager);
  const existingTls = nextInit.tls ?? {};
  const nextTls: FetchTlsOptions = { ...existingTls };

  if (context.snapshot.mode === 'custom' && !nextTls.ca && (!context.caEntries || context.caEntries.length === 0)) {
    throw new Error(
      'network.outboundTls.mode is custom, but no custom CA entries were loaded. Configure network.outboundTls.customCaFile or network.outboundTls.customCaDir.',
    );
  }

  if (!nextTls.ca && context.caEntries && context.caEntries.length > 0) {
    nextTls.ca = [...context.caEntries];
  }

  if (
    context.snapshot.allowInsecureLocalhost
    && nextTls.rejectUnauthorized === undefined
    && isLocalHostname(url.hostname)
  ) {
    nextTls.rejectUnauthorized = false;
  }

  return Object.keys(nextTls).length > 0
    ? { ...nextInit, tls: nextTls }
    : nextInit;
}

export function createNetworkFetch(
  fetchImpl: typeof globalThis.fetch,
  configManager: ConfigManager,
): typeof globalThis.fetch {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, applyOutboundTlsToFetchInit(input, init, configManager))) as typeof globalThis.fetch;
  Object.assign(wrapped, fetchImpl);
  return wrapped;
}

export class GlobalNetworkTransportInstaller {
  private originalFetchRef: typeof globalThis.fetch | null = null;
  private configManager: ConfigManager | null = null;

  setConfigManager(configManager: ConfigManager): void {
    this.configManager = configManager;
  }

  install(configManager: ConfigManager): void {
    const currentFetch = globalThis.fetch as WrappedNetworkFetch;
    if (currentFetch[NETWORK_FETCH_MANAGER]) {
      currentFetch[NETWORK_FETCH_MANAGER]!.setConfigManager(configManager);
      logger.debug('Updated global network transport', { ...inspectOutboundTls(configManager) });
      return;
    }

    this.configManager = configManager;
    this.originalFetchRef = globalThis.fetch.bind(globalThis);
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!this.originalFetchRef || !this.configManager) {
        throw new Error('Global network transport is not initialized correctly.');
      }
      return this.originalFetchRef(input, applyOutboundTlsToFetchInit(input, init, this.configManager));
    }) as WrappedNetworkFetch;
    Object.assign(wrapped, globalThis.fetch);
    wrapped[NETWORK_FETCH_WRAPPER] = true;
    wrapped[NETWORK_FETCH_MANAGER] = this;
    globalThis.fetch = wrapped;
    logger.debug('Installed global network transport', { ...inspectOutboundTls(configManager) });
  }
}
