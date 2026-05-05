import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import {
  exportEcosystemCatalogBundle,
  importEcosystemCatalogBundle,
  inspectEcosystemCatalogBundle,
  inspectInstalledEcosystemEntry,
  installEcosystemCatalogEntry,
  listEcosystemInstallBackups,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  rollbackInstalledEcosystemEntry,
  reviewEcosystemCatalogEntry,
  searchEcosystemCatalog,
  uninstallEcosystemCatalogEntry,
  updateInstalledEcosystemEntry,
  type EcosystemCatalogBundle,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '@/runtime/index.ts';
import { openCommandPanel, requireEcosystemCatalogPaths, requireReadModels, requireShellPaths } from './runtime-services.ts';

function resolveMarketplaceEntry(
  kind: EcosystemEntryKind,
  entryId: string,
  options: Parameters<typeof loadEcosystemCatalog>[1],
): EcosystemCatalogEntry | null {
  return loadEcosystemCatalog(kind, options).find((candidate) => candidate.id === entryId) ?? null;
}

function formatCompatibility(review: ReturnType<typeof reviewEcosystemCatalogEntry>): string {
  if (review.compatibility.reasons.length === 0) return 'compatible with current runtime';
  return review.compatibility.reasons.join('; ');
}

export function registerMarketplaceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'marketplace',
    aliases: ['catalog'],
    description: 'Browse the unified plugin and skill marketplace',
    usage: '[open|overview|recommend|browse [query]|review <plugin|skill|hook-pack|policy-pack> <id>|provenance <plugin|skill|hook-pack|policy-pack> <id>|install-hint <plugin|skill|hook-pack|policy-pack> <id>|install <plugin|skill|hook-pack|policy-pack> <id> [project|user]|update <plugin|skill|hook-pack|policy-pack> <id> [project|user]|rollback <plugin|skill|hook-pack|policy-pack> <id> [project|user] [backupId]|history <plugin|skill|hook-pack|policy-pack> <id> [project|user]|uninstall <plugin|skill|hook-pack|policy-pack> <id> [project|user]|receipt <plugin|skill|hook-pack|policy-pack> <id> [project|user]|bundle export <path> [project|user]|bundle inspect <path>|bundle import <path> [project|user]|installed]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        openCommandPanel(ctx, 'marketplace');
        return;
      }
      if (sub === 'overview') {
        const pluginCatalog = loadEcosystemCatalog('plugin', ecosystemPaths);
        const skillCatalog = loadEcosystemCatalog('skill', ecosystemPaths);
        const hookPackCatalog = loadEcosystemCatalog('hook-pack', ecosystemPaths);
        const policyPackCatalog = loadEcosystemCatalog('policy-pack', ecosystemPaths);
        const installedPlugins = listInstalledEcosystemEntries('plugin', ecosystemPaths);
        const installedSkills = listInstalledEcosystemEntries('skill', ecosystemPaths);
        const installedHookPacks = listInstalledEcosystemEntries('hook-pack', ecosystemPaths);
        const installedPolicyPacks = listInstalledEcosystemEntries('policy-pack', ecosystemPaths);
        ctx.print([
          'Marketplace Overview',
          `  curated plugins: ${pluginCatalog.length}`,
          `  curated skills: ${skillCatalog.length}`,
          `  curated hook packs: ${hookPackCatalog.length}`,
          `  curated policy packs: ${policyPackCatalog.length}`,
          `  installed plugins: ${installedPlugins.length}`,
          `  installed skills: ${installedSkills.length}`,
          `  installed hook packs: ${installedHookPacks.length}`,
          `  installed policy packs: ${installedPolicyPacks.length}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse') {
        const query = args.slice(1).join(' ');
        const pluginEntries = query ? searchEcosystemCatalog('plugin', query, ecosystemPaths) : loadEcosystemCatalog('plugin', ecosystemPaths);
        const skillEntries = query ? searchEcosystemCatalog('skill', query, ecosystemPaths) : loadEcosystemCatalog('skill', ecosystemPaths);
        const hookPackEntries = query ? searchEcosystemCatalog('hook-pack', query, ecosystemPaths) : loadEcosystemCatalog('hook-pack', ecosystemPaths);
        const policyPackEntries = query ? searchEcosystemCatalog('policy-pack', query, ecosystemPaths) : loadEcosystemCatalog('policy-pack', ecosystemPaths);
        ctx.print([
          `Marketplace Browse${query ? ` (${query})` : ''}`,
          `  plugins: ${pluginEntries.length}`,
          ...pluginEntries.map((entry) => `    plugin  ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  skills: ${skillEntries.length}`,
          ...skillEntries.map((entry) => `    skill   ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  hook packs: ${hookPackEntries.length}`,
          ...hookPackEntries.map((entry) => `    hook-pack   ${entry.id}  ${entry.name}  ${entry.summary}`),
          `  policy packs: ${policyPackEntries.length}`,
          ...policyPackEntries.map((entry) => `    policy-pack ${entry.id}  ${entry.name}  ${entry.summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'recommend') {
        const recommendations = requireReadModels(ctx).marketplace.getSnapshot().recommendations;
        ctx.print(recommendations.length > 0
          ? [
            'Marketplace Recommendations',
            ...recommendations.map((recommendation) => `  ${recommendation.kind} ${recommendation.entry.id}  ${recommendation.title}`),
            ...recommendations.map((recommendation) => `    ${recommendation.reason}  next=${recommendation.command}`),
          ].join('\n')
          : 'Marketplace Recommendations\n  No contextual recommendations right now.');
        return;
      }
      if (sub === 'installed') {
        const receipts = [
          ...listInstalledEcosystemEntries('plugin', ecosystemPaths).map((receipt) => `  plugin  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('skill', ecosystemPaths).map((receipt) => `  skill   ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('hook-pack', ecosystemPaths).map((receipt) => `  hook-pack   ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
          ...listInstalledEcosystemEntries('policy-pack', ecosystemPaths).map((receipt) => `  policy-pack ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ];
        ctx.print(receipts.length > 0
          ? ['Marketplace Installs', ...receipts].join('\n')
          : 'Marketplace Installs\n  No curated plugins or skills installed yet.');
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const target = args[2];
        const scope = args[3] === 'user' ? 'user' : 'project';
        if ((mode === 'export' || mode === 'inspect' || mode === 'import') && !target) {
          ctx.print(`Usage: /marketplace bundle ${mode} <path>${mode === 'export' || mode === 'import' ? ' [project|user]' : ''}`);
          return;
        }
        if (mode === 'export') {
          const bundle = exportEcosystemCatalogBundle(scope, ecosystemPaths);
          const targetPath = shellPaths.resolveWorkspacePath(target!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Marketplace bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(shellPaths.resolveWorkspacePath(target!), 'utf-8')) as EcosystemCatalogBundle;
          const summary = inspectEcosystemCatalogBundle(bundle);
          ctx.print([
            'Marketplace Bundle Review',
            `  exportedAt: ${new Date(summary.exportedAt).toISOString()}`,
            `  scope: ${summary.scope}`,
            `  plugins: ${summary.counts.plugin}`,
            `  skills: ${summary.counts.skill}`,
          ].join('\n'));
          return;
        }
        if (mode === 'import') {
          const bundle = JSON.parse(readFileSync(shellPaths.resolveWorkspacePath(target!), 'utf-8')) as EcosystemCatalogBundle;
          const result = importEcosystemCatalogBundle(bundle, { ...ecosystemPaths, scope });
          ctx.print([
            `Marketplace bundle imported from ${shellPaths.resolveWorkspacePath(target!)}`,
            `  entries: ${result.imported}`,
            ...Object.entries(result.pathByKind).map(([kind, path]) => `  ${kind}: ${path}`),
          ].join('\n'));
          return;
        }
        ctx.print('Usage: /marketplace bundle <export|inspect|import> <path> [project|user]');
        return;
      }

      const kind = args[1] as EcosystemEntryKind | undefined;
      const entryId = args[2];
      if ((sub === 'review' || sub === 'provenance' || sub === 'install-hint' || sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'history' || sub === 'uninstall' || sub === 'receipt') && (!kind || !entryId || !['plugin', 'skill', 'hook-pack', 'policy-pack'].includes(kind))) {
        ctx.print(`Usage: /marketplace ${sub} <plugin|skill|hook-pack|policy-pack> <id>${sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'history' || sub === 'uninstall' || sub === 'receipt' ? ' [project|user]' : ''}`);
        return;
      }
      if (sub === 'review') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) {
          ctx.print(`Unknown curated ${kind} entry: ${entryId}`);
          return;
        }
        const review = reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Marketplace Review: ${entry.name}`,
          `  kind: ${kind}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  compatibility: ${review.compatibility.status}`,
          `  notes: ${formatCompatibility(review)}`,
        ].join('\n'));
        return;
      }
      if (sub === 'provenance') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) {
          ctx.print(`Unknown curated ${kind} entry: ${entryId}`);
          return;
        }
        const review = reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Marketplace Provenance: ${entry.name}`,
          `  source: ${entry.source}`,
          `  provenance: ${entry.provenance ?? '(none declared)'}`,
          `  version: ${entry.version ?? '(unspecified)'}`,
          `  author: ${entry.author ?? '(unspecified)'}`,
          `  signature: ${entry.signature ?? '(none declared)'}`,
          `  compatibility: ${formatCompatibility(review)}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install-hint') {
        const entry = resolveMarketplaceEntry(kind!, entryId!, ecosystemPaths);
        if (!entry) {
          ctx.print(`Unknown curated ${kind} entry: ${entryId}`);
          return;
        }
        ctx.print([
          `Marketplace Install Guidance: ${entry.name}`,
          `  kind: ${kind}`,
          `  source: ${entry.source}`,
          `  install hint: ${entry.installHint ?? 'Install from a local curated source with explicit scope.'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'receipt') {
        const scope = args[3] === 'user' ? 'user' : 'project';
        const result = inspectInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope });
        if (!result.ok) {
          ctx.print(`Error: ${result.error}`);
          return;
        }
        const { receipt } = result;
        ctx.print([
          `Marketplace Receipt: ${receipt.entry.name}`,
          `  installedAt: ${new Date(receipt.installedAt).toISOString()}`,
          `  scope: ${receipt.scope}`,
          `  targetPath: ${receipt.targetPath}`,
          `  fingerprint: ${receipt.fingerprint}`,
          `  provenance: ${receipt.provenanceSummary}`,
          `  compatibility: ${receipt.compatibility.status}`,
          ...receipt.compatibility.reasons.map((reason) => `  note: ${reason}`),
        ].join('\n'));
        return;
      }
      if (sub === 'history') {
        const scope = args[3] === 'user' ? 'user' : 'project';
        const backups = listEcosystemInstallBackups(kind!, entryId!, { ...ecosystemPaths, scope });
        ctx.print(backups.length > 0
          ? [
            `Marketplace Rollback History: ${kind} ${entryId}`,
            ...backups.map((backup) => `  ${backup.id}  ${new Date(backup.createdAt).toISOString()}  ${backup.reason}  ${backup.receipt.entry.version ?? 'n/a'}`),
          ].join('\n')
          : `Marketplace Rollback History: ${kind} ${entryId}\n  No rollback backups recorded.`);
        return;
      }
      if (sub === 'install' || sub === 'update' || sub === 'rollback' || sub === 'uninstall') {
        const scope = args[3] === 'user' ? 'user' : 'project';
        if (sub === 'install') {
          const result = installEcosystemCatalogEntry(kind!, entryId!, { ...ecosystemPaths, scope });
          if (!result.ok) {
            ctx.print(`Error: ${result.error}`);
            return;
          }
          ctx.print(`Installed curated ${kind} ${entryId} into ${result.receipt.targetPath}`);
          return;
        }
        if (sub === 'update') {
          const result = updateInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope });
          if (!result.ok) {
            ctx.print(`Error: ${result.error}`);
            return;
          }
          ctx.print(`Updated curated ${kind} ${entryId} in ${result.receipt.targetPath}`);
          return;
        }
        if (sub === 'rollback') {
          const backupId = args[4];
          const result = rollbackInstalledEcosystemEntry(kind!, entryId!, { ...ecosystemPaths, scope, backupId });
          if (!result.ok) {
            ctx.print(`Error: ${result.error}`);
            return;
          }
          ctx.print(`Rolled back curated ${kind} ${entryId} in ${result.receipt.targetPath} using backup ${result.restoredFrom.id}`);
          return;
        }
        const result = uninstallEcosystemCatalogEntry(kind!, entryId!, { ...ecosystemPaths, scope });
        if (!result.ok) {
          ctx.print(`Error: ${result.error}`);
          return;
        }
        ctx.print(`Uninstalled curated ${kind} ${entryId} from ${result.removedPath}`);
        return;
      }
      ctx.print('Usage: /marketplace [open|overview|recommend|browse [query]|review <plugin|skill|hook-pack|policy-pack> <id>|provenance <plugin|skill|hook-pack|policy-pack> <id>|install-hint <plugin|skill|hook-pack|policy-pack> <id>|install <plugin|skill|hook-pack|policy-pack> <id> [project|user]|update <plugin|skill|hook-pack|policy-pack> <id> [project|user]|rollback <plugin|skill|hook-pack|policy-pack> <id> [project|user] [backupId]|history <plugin|skill|hook-pack|policy-pack> <id> [project|user]|uninstall <plugin|skill|hook-pack|policy-pack> <id> [project|user]|receipt <plugin|skill|hook-pack|policy-pack> <id> [project|user]|bundle export <path> [project|user]|bundle inspect <path>|bundle import <path> [project|user]|installed]');
    },
  });
}
