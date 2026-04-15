import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { CommandRegistry } from '../command-registry.ts';
import { buildIncidentMemoryAddOptions } from '@pellux/goodvibes-sdk/platform/state/memory-ingest';
import { requireShellPaths } from './runtime-services.ts';
import { getMemoryApi } from './recall-query.ts';

export function registerIncidentRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'incident',
    aliases: [],
    description: 'Open, export, and capture incident review bundles',
    usage: '[open | latest | show <id|latest> | export <id|latest> <path> | capture <id|latest>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const subcommand = (args[0] ?? 'open').toLowerCase();
      const forensicRegistry = ctx.extensions.forensicsRegistry;
      if (subcommand === 'open') {
        if (ctx.openIncidentPanel) {
          ctx.openIncidentPanel();
          return;
        }
        ctx.print('Incident panel is not available in this runtime.');
        return;
      }
      if (!forensicRegistry) {
        ctx.print('Forensics registry is not available in this runtime.');
        return;
      }
      const requestedId = args[1];
      const report = !requestedId || requestedId === 'latest'
        ? forensicRegistry.latest()
        : forensicRegistry.getById(requestedId);
      if (subcommand === 'latest' || subcommand === 'show') {
        if (!report) {
          ctx.print('No incident bundle is available.');
          return;
        }
        const bundle = forensicRegistry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        ctx.print([
          `Incident ${report.id}`,
          `  classification: ${report.classification}`,
          `  summary: ${report.summary}`,
          `  root cause: ${bundle.evidence.rootCause ?? 'n/a'}`,
          `  denied permissions: ${bundle.evidence.deniedPermissionCount}`,
          `  budget breaches: ${bundle.evidence.budgetBreachCount}`,
          `  replay mismatches: ${bundle.replay.mismatchCount}`,
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        const pathArg = args[2];
        if (!requestedId || !pathArg) {
          ctx.print('Usage: /incident export <id|latest> <path>');
          return;
        }
        if (!report) {
          ctx.print(`Incident not found: ${requestedId}`);
          return;
        }
        const bundleJson = forensicRegistry.exportBundleAsJson(report.id);
        if (!bundleJson) {
          ctx.print(`Failed to export incident bundle for ${report.id}.`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, `${bundleJson}\n`, 'utf-8');
        ctx.print(`Exported incident bundle ${report.id} to ${targetPath}`);
        return;
      }
      if (subcommand === 'capture') {
        const memory = getMemoryApi(ctx);
        if (!memory) return;
        if (!report) {
          ctx.print(`Incident not found: ${requestedId ?? 'latest'}`);
          return;
        }
        const bundle = forensicRegistry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        const record = await memory.add(buildIncidentMemoryAddOptions(bundle));
        ctx.print(`Captured incident ${report.id} into durable memory as ${record.id}`);
        return;
      }
      ctx.print('Usage: /incident [open | latest | show <id|latest> | export <id|latest> <path> | capture <id|latest>]');
    },
  });
}
