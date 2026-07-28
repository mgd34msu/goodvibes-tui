// Shared test helpers for the daemon-internal triage handler surface.
// No secret-shaped strings here — only obvious word-style fakes.

import { rm } from 'node:fs/promises';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import type { HandlerContext, HandlerLogger } from '../../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { GatewayMethodCatalog } from '../../../daemon/handlers/contracts.ts';
import type { InboundChannelItem } from '../../../daemon/handlers/triage/types.ts';

export function silentLogger(): HandlerLogger {
  return { info() {}, warn() {}, error() {} };
}

/** In-memory credential store keyed by config-key or raw key. */
export function fakeCredentials(
  entries: Record<string, string> = {},
): DaemonCredentialStore {
  const map = new Map(Object.entries(entries));
  return {
    async resolveRef(ref) {
      return map.get(ref) ?? null;
    },
    async resolveConfigSecret(configKey) {
      return map.get(configKey) ?? null;
    },
    async put(secretKey, value) {
      map.set(secretKey, value);
    },
    async has(secretKey) {
      return map.has(secretKey);
    },
  };
}

export interface FakeContextOptions {
  workingDirectory: string;
  catalog?: GatewayMethodCatalog;
  credentials?: DaemonCredentialStore;
  config?: Record<string, unknown>;
}

/** Build a minimal HandlerContext sufficient for triage tests. */
export function fakeContext(options: FakeContextOptions): HandlerContext {
  const config = options.config ?? {};
  return {
    catalog: (options.catalog ?? ({} as GatewayMethodCatalog)),
    credentials: options.credentials ?? fakeCredentials(),
    configManager: {
      get: ((key: string) => config[key]) as HandlerContext['configManager']['get'],
      getCategory: (() => ({})) as HandlerContext['configManager']['getCategory'],
    },
    workingDirectory: options.workingDirectory,
    homeDirectory: options.workingDirectory,
    logger: silentLogger(),
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return makeProjectTempDir(prefix.replace(/-+$/, ''));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function item(overrides: Partial<InboundChannelItem> & { id: string; surface: string }): InboundChannelItem {
  return { receivedAt: 1, unread: true, ...overrides };
}
