import { rmSync } from 'node:fs';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext, HandlerLogger } from '../../../daemon/handlers/context.ts';
import type {
  GatewayMethodInvocation,
} from '../../../daemon/handlers/contracts.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

/** A throwaway working directory rooted in the OS temp dir for SQLite files. */
export function makeTmpWorkingDir(): { dir: string; cleanup: () => void } {
  const dir = makeProjectTempDir('gv-routing-test');
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/** Collects logger calls so tests can assert PII-safe logging. */
export interface RecordingLogger extends HandlerLogger {
  readonly entries: Array<{ level: string; message: string; meta?: unknown }>;
}

export function makeRecordingLogger(): RecordingLogger {
  const entries: Array<{ level: string; message: string; meta?: unknown }> = [];
  return {
    entries,
    info: (message, meta) => entries.push({ level: 'info', message, meta }),
    warn: (message, meta) => entries.push({ level: 'warn', message, meta }),
    error: (message, meta) => entries.push({ level: 'error', message, meta }),
  };
}

/** Minimal config manager slice (routing reads nothing from config). */
function stubConfigManager(): HandlerContext['configManager'] {
  return {
    get: () => undefined,
    getCategory: () => ({}),
  } as unknown as HandlerContext['configManager'];
}

/** Build a HandlerContext wired to a fresh catalog + tmp working dir. */
export function makeHandlerContext(workingDirectory: string): {
  ctx: HandlerContext;
  catalog: GatewayMethodCatalog;
  logger: RecordingLogger;
} {
  const catalog = new GatewayMethodCatalog();
  const logger = makeRecordingLogger();
  const ctx: HandlerContext = {
    catalog,
    credentials: {
      resolveRef: async () => null,
      resolveConfigSecret: async () => null,
      put: async () => undefined,
      has: async () => false,
    } as unknown as HandlerContext['credentials'],
    configManager: stubConfigManager(),
    workingDirectory,
    homeDirectory: workingDirectory,
    logger,
  };
  return { ctx, catalog, logger };
}

/** Build a gateway invocation envelope with sensible defaults. */
export function makeInvocation(
  body: unknown,
  overrides: Partial<GatewayMethodInvocation['context']> = {},
): GatewayMethodInvocation {
  return {
    body,
    query: {},
    context: {
      authToken: 'test-auth-token',
      principalId: 'user-1',
      admin: true,
      scopes: ['read:channels', 'write:channels'],
      metadata: { explicitUserRequest: true },
      ...overrides,
    },
  } as GatewayMethodInvocation;
}
