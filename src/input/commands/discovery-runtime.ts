import type { CommandRegistry } from '../command-registry.ts';
import { scan, persistProviders } from '../../discovery/index.ts';
import { requireProviderApi, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '../../utils/error-display.ts';

export function registerDiscoveryRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'scan',
    aliases: [],
    description: 'Scan localhost and LAN for local LLM servers',
    async handler(_args, ctx) {
      ctx.print('Scanning for local LLM servers...');
      ctx.renderRequest();

      const result = await scan();

      if (result.servers.length === 0) {
        ctx.print(
          `[Scan] No local LLM servers found (scanned ${result.scannedHosts} hosts, ` +
          `${result.scannedPorts} ports in ${Math.round(result.durationMs / 1000)}s)`,
        );
      } else {
        const lines = [
          `[Scan] Found ${result.servers.length} server(s) in ${Math.round(result.durationMs / 1000)}s:`,
          '',
          ...result.servers.map((server) =>
            `  ${server.name.padEnd(30)} ${server.models.length} model(s)  ${server.host}:${server.port}`,
          ),
          '',
          'Use /model to select a discovered model.',
        ];
        ctx.print(lines.join('\n'));
      }

      try {
        await requireProviderApi(ctx).registerDiscoveredProviders(result.servers);
      } catch (err) {
        ctx.print(`[Scan] Warning: failed to register some providers: ${summarizeError(err)}`);
      }

      if (result.servers.length > 0) persistProviders(requireShellPaths(ctx), result.servers);
      ctx.renderRequest();
    },
  });
}
