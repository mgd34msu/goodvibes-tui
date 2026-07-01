/**
 * Host-facing context passed to every surface register function. Replaces the
 * former OperatorContext. It carries the SDK gateway catalog (handlers attach
 * to it), the daemon credential store, a read-only slice of the config manager,
 * resolved directories, and a logger. No SDK descriptor or schema is declared
 * here — the catalog type is re-exported through the contracts seam.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { GatewayMethodCatalog } from './contracts.ts';
import type { DaemonCredentialStore } from './credentials.ts';
import type { Unregister } from './register.ts';

export interface HandlerLogger {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface HandlerContext {
  readonly catalog: GatewayMethodCatalog;
  readonly credentials: DaemonCredentialStore;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly logger: HandlerLogger;
}

/** Every surface module exports a register function of this shape. */
export type SurfaceRegister = (ctx: HandlerContext) => Unregister;
