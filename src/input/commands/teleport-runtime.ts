import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import type { RemoteSessionBundle } from '../../runtime/remote/types.ts';

function inspectRemoteSessionBundle(bundle: RemoteSessionBundle): string {
  return [
    'Teleport Bundle Review',
    `  session: ${bundle.sessionId}`,
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  active connections: ${bundle.activeConnectionIds.length}`,
    `  pools: ${bundle.pools.length}`,
    `  contracts: ${bundle.contracts.length}`,
    `  artifacts: ${bundle.artifacts.length}`,
  ].join('\n');
}

export function registerTeleportRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'teleport',
    description: 'Package, inspect, and import portable remote-session handoff bundles',
    usage: '[export <path>|inspect <path>|import <path>]',
    async handler(args, ctx) {
      const mode = (args[0] ?? 'export').toLowerCase();
      const pathArg = args[1];
      if (!pathArg) {
        ctx.print('Usage: /teleport [export <path>|inspect <path>|import <path>]');
        return;
      }
      const store = ctx.runtimeStore;
      if (!store) {
        ctx.print('Runtime store is not available for teleport commands.');
        return;
      }
      if (!ctx.remoteRunnerRegistry) {
        ctx.print('Remote runner registry is not available in this runtime.');
        return;
      }
      const targetPath = resolve(process.cwd(), pathArg);
      const remoteRegistry = ctx.remoteRunnerRegistry;
      remoteRegistry.ensureContractsFromStore(store);
      if (mode === 'export') {
        const exported = await remoteRegistry.exportSessionBundle(store, targetPath);
        ctx.print(`Teleport bundle exported for session ${exported.bundle.sessionId} to ${exported.path}`);
        return;
      }
      if (mode === 'inspect') {
        const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as RemoteSessionBundle;
        ctx.print(inspectRemoteSessionBundle(bundle));
        return;
      }
      if (mode === 'import') {
        const bundle = await remoteRegistry.importSessionBundle(targetPath);
        ctx.print(`Imported teleport bundle ${bundle.sessionId} with ${bundle.contracts.length} contracts.`);
        return;
      }
      ctx.print('Usage: /teleport [export <path>|inspect <path>|import <path>]');
    },
  });
}
