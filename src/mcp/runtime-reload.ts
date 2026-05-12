import { statSync } from 'node:fs';
import { getMcpConfigLocations, type McpConfigRoots, type McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';

export interface McpRuntimeReloadHandle {
  stop(): void;
}

interface McpRuntimeReloadOptions {
  readonly roots: McpConfigRoots;
  readonly registry: Pick<McpRegistry, 'reload' | 'listServerSecurity'>;
  readonly onReload?: (summary: { connected: number; total: number }) => void;
  readonly onError?: (error: unknown) => void;
  readonly intervalMs?: number;
}

interface FileSignature {
  readonly exists: boolean;
  readonly mtimeMs: number;
  readonly size: number;
}

function candidateMcpConfigPaths(roots: McpConfigRoots): string[] {
  return getMcpConfigLocations(roots).map((location) => location.path);
}

function signatureFor(path: string): FileSignature {
  try {
    const stat = statSync(path);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function signaturesDiffer(a: readonly FileSignature[], b: readonly FileSignature[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((entry, index) => {
    const other = b[index];
    return !other || entry.exists !== other.exists || entry.mtimeMs !== other.mtimeMs || entry.size !== other.size;
  });
}

export function startMcpConfigAutoReload(options: McpRuntimeReloadOptions): McpRuntimeReloadHandle {
  const paths = candidateMcpConfigPaths(options.roots);
  const intervalMs = Math.max(500, options.intervalMs ?? 2_000);
  let stopped = false;
  let reloading = false;
  let last = paths.map(signatureFor);

  const reload = async (): Promise<void> => {
    if (stopped || reloading) return;
    reloading = true;
    try {
      await options.registry.reload(options.roots);
      const servers = options.registry.listServerSecurity();
      options.onReload?.({
        connected: servers.filter((server) => server.connected).length,
        total: servers.length,
      });
    } catch (error) {
      options.onError?.(error);
    } finally {
      reloading = false;
    }
  };

  const interval = setInterval(() => {
    const next = paths.map(signatureFor);
    if (!signaturesDiffer(last, next)) return;
    last = next;
    void reload();
  }, intervalMs);
  interval.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}
