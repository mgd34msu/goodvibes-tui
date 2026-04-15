import type { CommandRegistry } from '../command-registry.ts';
import { discoverSkills } from '../../panels/skills-panel.ts';
import {
  installEcosystemCatalogEntry,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  removeEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  searchEcosystemCatalog,
  uninstallEcosystemCatalogEntry,
  updateInstalledEcosystemEntry,
  upsertEcosystemCatalogEntry,
} from '@pellux/goodvibes-sdk/platform/runtime/ecosystem/catalog';
import { requireEcosystemCatalogPaths, requirePanelManager, requireShellPaths } from './runtime-services.ts';

export function registerSkillsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'skills',
    aliases: ['skill'],
    description: 'Inspect installed skill packs',
    usage: '[open|list|show <name>|origins|browse [query]|installed|catalog-review <id>|publish-local <id> <path> <summary...>|unpublish <id>|install-hint <catalog-id>|install <id> [project|user]|update <id> [project|user]|uninstall <id> [project|user]]',
    handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        if (ctx.showPanel) ctx.showPanel('skills');
        else {
          const panelManager = requirePanelManager(ctx);
          panelManager.open('skills');
          panelManager.show();
          ctx.renderRequest();
        }
        return;
      }
      const skills = discoverSkills(requireShellPaths(ctx));
      const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
      if (sub === 'list') {
        if (skills.length === 0) {
          ctx.print('No skills discovered.');
          return;
        }
        ctx.print([
          `Skills (${skills.length})`,
          ...skills.map((skill) => `  ${skill.name}  [${skill.origin}]  ${skill.description || 'No description provided.'}`),
        ].join('\n'));
        return;
      }
      if (sub === 'origins') {
        const counts = new Map<string, number>();
        for (const skill of skills) counts.set(skill.origin, (counts.get(skill.origin) ?? 0) + 1);
        ctx.print([
          'Skill Origins',
          ...[...counts.entries()].map(([origin, count]) => `  ${origin}: ${count}`),
        ].join('\n'));
        return;
      }
      if (sub === 'show') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /skills show <name>');
          return;
        }
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) {
          ctx.print(`Unknown skill: ${name}`);
          return;
        }
        ctx.print([
          `Skill ${skill.name}`,
          `  origin: ${skill.origin}`,
          `  path: ${skill.path}`,
          `  description: ${skill.description || 'No description provided.'}`,
          `  dependencies: ${skill.dependencies.join(', ') || '(none)'}`,
          `  includes: ${skill.includes.join(', ') || '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'browse' || sub === 'catalog') {
        const query = args.slice(1).join(' ');
        const entries = query ? searchEcosystemCatalog('skill', query, ecosystemPaths) : loadEcosystemCatalog('skill', ecosystemPaths);
        if (entries.length === 0) {
          ctx.print(query
            ? `No curated skill catalog entries matched "${query}".`
            : 'No curated skill catalog entries found. Add .goodvibes/tui/ecosystem/skills.json to publish a local-first skill catalog.');
          return;
        }
        ctx.print([
          `Curated Skill Catalog (${entries.length})`,
          ...entries.map((entry) => `  ${entry.id}  ${entry.name}  [${entry.tags.join(', ') || 'untagged'}]  ${entry.summary}`),
        ].join('\n'));
        return;
      }
      if (sub === 'installed') {
        const receipts = listInstalledEcosystemEntries('skill', ecosystemPaths);
        if (receipts.length === 0) {
          ctx.print('No curated skills installed from local catalogs yet.');
          return;
        }
        ctx.print([
          `Installed Curated Skills (${receipts.length})`,
          ...receipts.map((receipt) => `  ${receipt.entry.id}  ${receipt.scope}  ${receipt.targetPath}`),
        ].join('\n'));
        return;
      }
      if (sub === 'catalog-review') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills catalog-review <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('skill', ecosystemPaths).find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated skill entry: ${entryId}`);
          return;
        }
        const review = reviewEcosystemCatalogEntry(entry, ecosystemPaths);
        ctx.print([
          `Skill Catalog Review: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  sourceKind: ${review.sourceKind}`,
          `  sourceExists: ${review.sourceExists ? 'yes' : 'no'}`,
          `  recommendedScope: ${review.recommendedScope}`,
          `  risk: ${review.riskLevel}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  provenance: ${entry.provenance ?? '(none)'}`,
          `  update hint: ${entry.updateHint ?? '(none)'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'publish-local') {
        const entryId = args[1];
        const sourcePath = args[2];
        const summary = args.slice(3).join(' ').trim();
        if (!entryId || !sourcePath || !summary) {
          ctx.print('Usage: /skills publish-local <catalog-id> <path> <summary...>');
          return;
        }
        const result = upsertEcosystemCatalogEntry({
          id: entryId,
          kind: 'skill',
          name: entryId.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()),
          summary,
          source: sourcePath,
          tags: ['local-first', 'published'],
          provenance: 'operator-published',
          updateHint: 'Use /skills publish-local again to refresh catalog metadata after edits.',
        }, ecosystemPaths);
        ctx.print(result.ok ? `Published curated skill ${entryId} into ${result.path}` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'unpublish') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills unpublish <catalog-id>');
          return;
        }
        const result = removeEcosystemCatalogEntry('skill', entryId, ecosystemPaths);
        ctx.print(result.ok ? `Removed curated skill ${entryId} from ${result.path}` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'install-hint') {
        const entryId = args[1];
        if (!entryId) {
          ctx.print('Usage: /skills install-hint <catalog-id>');
          return;
        }
        const entry = loadEcosystemCatalog('skill', ecosystemPaths).find((candidate) => candidate.id === entryId);
        if (!entry) {
          ctx.print(`Unknown curated skill entry: ${entryId}`);
          return;
        }
        ctx.print([
          `Skill Install Guidance: ${entry.name}`,
          `  id: ${entry.id}`,
          `  source: ${entry.source}`,
          `  tags: ${entry.tags.join(', ') || '(none)'}`,
          `  trust notes: ${entry.trustNotes ?? '(none)'}`,
          `  install hint: ${entry.installHint ?? 'Place the skill pack under a configured skill directory and refresh the skills panel.'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'install') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills install <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = installEcosystemCatalogEntry('skill', entryId, { ...ecosystemPaths, scope });
        ctx.print(result.ok ? `Installed curated skill ${entryId} into ${result.receipt.targetPath}` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'update') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills update <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = updateInstalledEcosystemEntry('skill', entryId, { ...ecosystemPaths, scope });
        ctx.print(result.ok ? `Updated curated skill ${entryId} in ${result.receipt.targetPath}` : `Error: ${result.error}`);
        return;
      }
      if (sub === 'uninstall') {
        const entryId = args[1];
        const scopeArg = args[2];
        if (!entryId) {
          ctx.print('Usage: /skills uninstall <catalog-id> [project|user]');
          return;
        }
        const scope = scopeArg === 'project' ? 'project' : 'user';
        const result = uninstallEcosystemCatalogEntry('skill', entryId, { ...ecosystemPaths, scope });
        ctx.print(result.ok ? `Uninstalled curated skill ${entryId} from ${result.removedPath}` : `Error: ${result.error}`);
        return;
      }
      ctx.print('Usage: /skills [open|list|show <name>|origins|browse [query]|installed|catalog-review <id>|publish-local <id> <path> <summary...>|unpublish <id>|install-hint <catalog-id>|install <id> [project|user]|update <id> [project|user]|uninstall <id> [project|user]]');
    },
  });
}
