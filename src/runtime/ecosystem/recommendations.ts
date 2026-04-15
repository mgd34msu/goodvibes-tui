import type { RuntimeStore } from '../store/index.ts';
import {
  type EcosystemCatalogPathOptions,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '@pellux/goodvibes-sdk/platform/runtime/ecosystem/catalog';

export interface EcosystemRecommendation {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly kind: EcosystemEntryKind;
  readonly entry: EcosystemCatalogEntry;
  readonly command: string;
}

function matchesTags(entry: EcosystemCatalogEntry, terms: readonly string[]): boolean {
  const haystack = [
    entry.id,
    entry.name,
    entry.summary,
    entry.installHint ?? '',
    ...entry.tags,
  ].join(' ').toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function pushCatalogMatches(
  target: EcosystemRecommendation[],
  kind: EcosystemEntryKind,
  terms: readonly string[],
  reason: string,
  title: string,
  options: EcosystemCatalogPathOptions,
): void {
  const installed = new Set(listInstalledEcosystemEntries(kind, options).map((receipt) => receipt.entry.id));
  for (const entry of loadEcosystemCatalog(kind, options)) {
    if (installed.has(entry.id)) continue;
    if (!matchesTags(entry, terms)) continue;
    target.push({
      id: `${kind}:${entry.id}`,
      title,
      reason,
      kind,
      entry,
      command: `/marketplace review ${kind} ${entry.id}`,
    });
  }
}

export function buildEcosystemRecommendations(
  runtimeStore: RuntimeStore | undefined,
  options: EcosystemCatalogPathOptions,
): EcosystemRecommendation[] {
  const recommendations: EcosystemRecommendation[] = [];
  const state = runtimeStore?.getState();

  const installedPlugins = listInstalledEcosystemEntries('plugin', options).length;
  const installedSkills = listInstalledEcosystemEntries('skill', options).length;
  if (installedPlugins === 0) {
    pushCatalogMatches(
      recommendations,
      'plugin',
      ['provider', 'workflow', 'remote', 'mcp'],
      'No curated plugins are installed yet. Start with a project-scoped integration or workflow plugin.',
      'Seed the plugin posture',
      options,
    );
  }
  if (installedSkills === 0) {
    pushCatalogMatches(
      recommendations,
      'skill',
      ['review', 'docs', 'refactor', 'workflow'],
      'No curated skills are installed yet. Add a skill pack that matches your project workflow.',
      'Seed the skill posture',
      options,
    );
  }

  if ((state?.permissions.denialCount ?? 0) >= 3) {
    pushCatalogMatches(
      recommendations,
      'policy-pack',
      ['policy', 'approval', 'security', 'sandbox'],
      'Repeated denials suggest a reusable policy pack or trust posture adjustment may help.',
      'Review policy-pack options',
      options,
    );
  }

  const authRequiredServers = [...(state?.mcp.servers.values() ?? [])].filter((server) => server.status === 'auth_required');
  if (authRequiredServers.length > 0) {
    pushCatalogMatches(
      recommendations,
      'hook-pack',
      ['auth', 'mcp', 'oauth', 'service'],
      `${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} require authentication or reconnect help.`,
      'Review MCP auth helpers',
      options,
    );
    pushCatalogMatches(
      recommendations,
      'plugin',
      ['mcp', 'remote', 'service'],
      `${authRequiredServers.length} MCP server${authRequiredServers.length === 1 ? '' : 's'} require authentication or reconnect help.`,
      'Review MCP-aware plugins',
      options,
    );
  }

  return recommendations
    .filter((recommendation, index, items) => items.findIndex((candidate) => candidate.id === recommendation.id) === index)
    .slice(0, 8);
}
