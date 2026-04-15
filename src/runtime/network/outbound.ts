import { existsSync, readFileSync } from 'node:fs';
import { getCACertificates } from 'node:tls';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { isLocalHostname, readPemEntriesFromDirectory, resolvePathFromGoodVibesRoot } from '@pellux/goodvibes-sdk/platform/runtime/network/shared';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

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

function extractRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function extractHeaderValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const loweredName = name.toLowerCase();
    const match = headers.find(([key]) => key.toLowerCase() === loweredName);
    return match?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    if (Array.isArray(value)) return value.join(', ');
    return value;
  }
  return undefined;
}

function shouldTraceProviderRequest(url: URL, method: string): boolean {
  if (method !== 'POST') return false;
  return (
    url.pathname.endsWith('/chat/completions') ||
    url.pathname.endsWith('/responses') ||
    url.pathname.endsWith('/messages')
  );
}

async function executeNetworkFetch(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  configManager: ConfigManager,
): Promise<Response> {
  const nextInit = applyOutboundTlsToFetchInit(input, init, configManager);
  const url = extractRequestUrl(input);
  const method = extractRequestMethod(input, nextInit);
  const shouldTrace = url ? shouldTraceProviderRequest(url, method) : false;

  if (shouldTrace && url) {
    logger.debug('Outbound provider request', {
      method,
      host: url.host,
      path: url.pathname,
      contentType: extractHeaderValue(nextInit.headers, 'content-type'),
      contentLength: extractHeaderValue(nextInit.headers, 'content-length'),
    });
  }

  try {
    const response = await fetchImpl(input, nextInit);
    if (shouldTrace && url) {
      logger.debug('Outbound provider response', {
        method,
        host: url.host,
        path: url.pathname,
        status: response.status,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined,
      });
    }
    return response;
  } catch (error) {
    if (shouldTrace && url) {
      logger.error('Outbound provider request failed', {
        method,
        host: url.host,
        path: url.pathname,
        error: summarizeError(error),
      });
    }
    throw error;
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
    executeNetworkFetch(fetchImpl, input, init, configManager)) as typeof globalThis.fetch;
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
      return executeNetworkFetch(this.originalFetchRef, input, init, this.configManager);
    }) as WrappedNetworkFetch;
    Object.assign(wrapped, globalThis.fetch);
    wrapped[NETWORK_FETCH_WRAPPER] = true;
    wrapped[NETWORK_FETCH_MANAGER] = this;
    globalThis.fetch = wrapped;
    logger.debug('Installed global network transport', { ...inspectOutboundTls(configManager) });
  }
}
