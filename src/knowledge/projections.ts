import type { ArtifactStore } from '../artifacts/index.ts';
import type { KnowledgeStore } from './store.ts';
import type {
  KnowledgeConnector,
  KnowledgeIssueRecord,
  KnowledgeMaterializedProjection,
  KnowledgeNodeRecord,
  KnowledgeProjectionBundle,
  KnowledgeProjectionPage,
  KnowledgeProjectionTarget,
  KnowledgeProjectionTargetKind,
  KnowledgeSourceRecord,
} from './types.ts';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function quote(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `> ${trimmed.replace(/\n+/g, '\n> ')}` : null;
}

function formatDateTime(timestamp: number | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function codeFenceJson(value: Record<string, unknown> | undefined): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

function joinSections(...sections: Array<string | null | undefined>): string {
  return sections.filter((section): section is string => typeof section === 'string' && section.trim().length > 0).join('\n\n');
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}

function buildBulletList(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- none';
}

function sortByTitle<T extends { title?: string }>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
}

export interface KnowledgeProjectionServiceOptions {
  readonly connectors?: () => readonly KnowledgeConnector[];
}

export class KnowledgeProjectionService {
  private readonly getConnectors: () => readonly KnowledgeConnector[];

  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    options: KnowledgeProjectionServiceOptions = {},
  ) {
    this.getConnectors = options.connectors ?? (() => []);
  }

  async listTargets(limit = 25): Promise<KnowledgeProjectionTarget[]> {
    await this.store.init();
    const max = Math.max(1, limit);
    const targets: KnowledgeProjectionTarget[] = [this.createPresetTarget('overview'), this.createPresetTarget('bundle')];
    const remaining = Math.max(1, max - targets.length);
    const perKind = Math.max(1, Math.ceil(remaining / 4));
    const sources = this.store.listSources(perKind).map((source) => this.createSourceTarget(source));
    const nodes = this.store.listNodes(perKind).map((node) => this.createNodeTarget(node));
    const issues = this.store.listIssues(perKind).map((issue) => this.createIssueTarget(issue));
    const rollups = this.store.listNodes(10_000)
      .filter((node) => node.kind === 'domain' || node.kind === 'topic' || node.kind === 'bookmark_folder')
      .slice(0, Math.max(2, perKind))
      .map((node) => this.createRollupTarget(node));
    const dashboards = [this.createDashboardTarget('source-health'), this.createDashboardTarget('backlinks')];
    return [...targets, ...sources, ...nodes, ...issues, ...dashboards, ...rollups].slice(0, max);
  }

  async render(
    input: {
      readonly kind: KnowledgeProjectionTargetKind;
      readonly id?: string;
      readonly limit?: number;
    },
  ): Promise<KnowledgeProjectionBundle> {
    await this.store.init();
    const limit = Math.max(1, input.limit ?? 12);
    const target = this.resolveTarget(input.kind, input.id);
    if (!target) {
      throw new Error(`Unknown knowledge projection target: ${input.kind}${input.id ? `/${input.id}` : ''}`);
    }

    switch (target.kind) {
      case 'overview':
        return this.bundleFromPages(target, [this.renderOverviewPage(target, limit)], { preset: 'overview' });
      case 'bundle':
        return this.renderBundleTarget(target, limit);
      case 'source':
        return this.bundleFromPages(target, [this.renderSourcePage(target.itemId!)], {});
      case 'node':
        return this.bundleFromPages(target, [this.renderNodePage(target.itemId!)], {});
      case 'issue':
        return this.bundleFromPages(target, [this.renderIssuePage(target.itemId!)], {});
      case 'dashboard':
        return this.bundleFromPages(target, [this.renderDashboardPage(target, limit)], { preset: 'dashboard' });
      case 'rollup':
        return this.bundleFromPages(target, [this.renderRollupPage(target.itemId!, target)], { preset: 'rollup' });
      default:
        return this.bundleFromPages(target, [this.renderOverviewPage(this.createPresetTarget('overview'), limit)], {});
    }
  }

  async materialize(
    input: {
      readonly kind: KnowledgeProjectionTargetKind;
      readonly id?: string;
      readonly limit?: number;
      readonly filename?: string;
    },
  ): Promise<KnowledgeMaterializedProjection> {
    const bundle = await this.render(input);
    const content = this.combineBundleMarkdown(bundle);
    const artifact = await this.artifactStore.create({
      text: content,
      mimeType: 'text/markdown',
      filename: input.filename?.trim() || bundle.target.defaultFilename,
      metadata: {
        projectionId: bundle.id,
        targetId: bundle.target.targetId,
        targetKind: bundle.target.kind,
        pageCount: bundle.pageCount,
        pagePaths: bundle.pages.map((page) => page.path),
        itemIds: dedupe(bundle.pages.flatMap((page) => page.itemIds), (id) => id),
      },
    });
    return { bundle, artifact };
  }

  private resolveTarget(kind: KnowledgeProjectionTargetKind, id?: string): KnowledgeProjectionTarget | null {
    if (kind === 'overview' || kind === 'bundle') return this.createPresetTarget(kind);
    if (kind === 'dashboard') return this.createDashboardTarget(id ?? 'source-health');
    if (kind === 'rollup') {
      if (!id?.trim()) return null;
      const node = this.store.getNode(id);
      return node ? this.createRollupTarget(node) : null;
    }
    if (!id?.trim()) return null;
    if (kind === 'source') {
      const source = this.store.getSource(id);
      return source ? this.createSourceTarget(source) : null;
    }
    if (kind === 'node') {
      const node = this.store.getNode(id);
      return node ? this.createNodeTarget(node) : null;
    }
    const issue = this.store.getIssue(id);
    return issue ? this.createIssueTarget(issue) : null;
  }

  private createPresetTarget(kind: 'overview' | 'bundle'): KnowledgeProjectionTarget {
    if (kind === 'overview') {
      return {
        targetId: 'overview',
        kind,
        title: 'Knowledge Overview',
        description: 'A compact markdown projection of the current structured knowledge store.',
        defaultPath: 'wiki/index.md',
        defaultFilename: 'knowledge-overview.md',
        metadata: {},
      };
    }
    return {
      targetId: 'bundle',
      kind,
      title: 'Knowledge Bundle',
      description: 'A multi-page markdown bundle containing indexes, dashboards, and recent records.',
      defaultPath: 'wiki/bundle/index.md',
      defaultFilename: 'knowledge-bundle.md',
      metadata: {},
    };
  }

  private createDashboardTarget(id: string): KnowledgeProjectionTarget {
    if (id === 'backlinks') {
      return {
        targetId: 'dashboard:backlinks',
        kind: 'dashboard',
        title: 'Backlinks Dashboard',
        description: 'Derived backlink and cross-reference projection across sources and nodes.',
        itemId: 'backlinks',
        defaultPath: 'wiki/dashboards/backlinks.md',
        defaultFilename: 'knowledge-backlinks.md',
        metadata: { dashboard: 'backlinks' },
      };
    }
    return {
      targetId: 'dashboard:source-health',
      kind: 'dashboard',
      title: 'Source Health Dashboard',
      description: 'Derived staleness, issue, and extraction-health projection.',
      itemId: 'source-health',
      defaultPath: 'wiki/dashboards/source-health.md',
      defaultFilename: 'knowledge-source-health.md',
      metadata: { dashboard: 'source-health' },
    };
  }

  private createRollupTarget(node: KnowledgeNodeRecord): KnowledgeProjectionTarget {
    return {
      targetId: `rollup:${node.id}`,
      kind: 'rollup',
      title: `${node.title} Rollup`,
      description: `Rollup projection for ${node.kind} ${node.title}.`,
      itemId: node.id,
      defaultPath: `wiki/rollups/${node.kind}-${node.slug}.md`,
      defaultFilename: `${node.kind}-${node.slug}-rollup.md`,
      metadata: {
        kind: node.kind,
      },
    };
  }

  private createSourceTarget(source: KnowledgeSourceRecord): KnowledgeProjectionTarget {
    const title = source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id;
    return {
      targetId: `source:${source.id}`,
      kind: 'source',
      title,
      description: 'Markdown projection for a structured knowledge source.',
      itemId: source.id,
      defaultPath: `wiki/sources/${source.id}.md`,
      defaultFilename: `${slugify(title)}.md`,
      metadata: {
        sourceType: source.sourceType,
        status: source.status,
      },
    };
  }

  private createNodeTarget(node: KnowledgeNodeRecord): KnowledgeProjectionTarget {
    return {
      targetId: `node:${node.id}`,
      kind: 'node',
      title: node.title,
      description: 'Markdown projection for a structured knowledge node.',
      itemId: node.id,
      defaultPath: `wiki/nodes/${node.kind}-${node.slug}.md`,
      defaultFilename: `${node.kind}-${node.slug}.md`,
      metadata: {
        kind: node.kind,
        status: node.status,
      },
    };
  }

  private createIssueTarget(issue: KnowledgeIssueRecord): KnowledgeProjectionTarget {
    return {
      targetId: `issue:${issue.id}`,
      kind: 'issue',
      title: issue.message,
      description: 'Markdown projection for a structured knowledge lint or health issue.',
      itemId: issue.id,
      defaultPath: `wiki/issues/${issue.id}.md`,
      defaultFilename: `${issue.id}.md`,
      metadata: {
        severity: issue.severity,
        code: issue.code,
      },
    };
  }

  private renderOverviewPage(target: KnowledgeProjectionTarget, limit: number): KnowledgeProjectionPage {
    const status = this.store.status();
    const sources = this.store.listSources(limit);
    const nodes = this.store.listNodes(limit);
    const issues = this.store.listIssues(limit);
    const connectors = this.getConnectors();
    const runs = this.store.listJobRuns(5);
    const content = joinSections(
      `# ${target.title}`,
      'Structured knowledge is canonical in SQL. This markdown page is a derived projection for clients, exports, and future wiki-style surfaces.',
      [
        '## Counts',
        `- sources: ${status.sourceCount}`,
        `- nodes: ${status.nodeCount}`,
        `- edges: ${status.edgeCount}`,
        `- issues: ${status.issueCount}`,
        `- extractions: ${status.extractionCount}`,
        `- job runs: ${status.jobRunCount}`,
      ].join('\n'),
      [
        '## Connectors',
        buildBulletList(connectors.map((connector) => `\`${connector.id}\` - ${connector.description}`)),
      ].join('\n'),
      [
        '## Recent Job Runs',
        buildBulletList(runs.map((run) => `\`${run.jobId}\` - ${run.status} (${formatDateTime(run.completedAt ?? run.startedAt ?? run.requestedAt) ?? 'n/a'})`)),
      ].join('\n'),
      [
        '## Recent Sources',
        buildBulletList(sources.map((source) => this.linkToTarget(this.createSourceTarget(source), `${source.title ?? source.canonicalUri ?? source.id} (${source.sourceType})`))),
      ].join('\n'),
      [
        '## Recent Nodes',
        buildBulletList(nodes.map((node) => this.linkToTarget(this.createNodeTarget(node), `${node.title} (${node.kind})`))),
      ].join('\n'),
      [
        '## Open Issues',
        buildBulletList(issues.map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [],
      metadata: {
        generatedFrom: 'knowledge-overview',
      },
    };
  }

  private renderSourceIndexPage(limit: number): KnowledgeProjectionPage {
    const sources = sortByTitle(this.store.listSources(10_000).slice(0, limit));
    const lines = [
      '# Sources Index',
      '',
      ...sources.map((source) => {
        const extraction = this.store.getExtractionBySourceId(source.id);
        const health = source.status === 'indexed' ? 'healthy' : source.status;
        return `- ${this.linkToTarget(this.createSourceTarget(source), source.title ?? source.canonicalUri ?? source.id)} | ${source.sourceType} | ${health}${extraction ? ` | ${extraction.format}` : ''}`;
      }),
    ];
    return {
      path: 'wiki/indexes/sources.md',
      title: 'Sources Index',
      format: 'markdown',
      content: lines.join('\n'),
      itemIds: sources.map((source) => source.id),
      metadata: {
        kind: 'sources-index',
      },
    };
  }

  private renderNodeIndexPage(limit: number): KnowledgeProjectionPage {
    const nodes = sortByTitle(this.store.listNodes(10_000).slice(0, limit));
    const grouped = new Map<string, KnowledgeNodeRecord[]>();
    for (const node of nodes) {
      const bucket = grouped.get(node.kind) ?? [];
      bucket.push(node);
      grouped.set(node.kind, bucket);
    }
    const sections = [...grouped.entries()].map(([kind, entries]) => [
      `## ${kind}`,
      buildBulletList(entries.map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.status})`))),
    ].join('\n'));
    return {
      path: 'wiki/indexes/nodes.md',
      title: 'Nodes Index',
      format: 'markdown',
      content: ['# Nodes Index', ...sections].join('\n\n'),
      itemIds: nodes.map((node) => node.id),
      metadata: {
        kind: 'nodes-index',
      },
    };
  }

  private renderIssueDashboardPage(limit: number): KnowledgeProjectionPage {
    const issues = this.store.listIssues(limit);
    const severityGroups = ['error', 'warning', 'info'].map((severity) => [
      `## ${severity.toUpperCase()}`,
      buildBulletList(issues
        .filter((issue) => issue.severity === severity)
        .map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.code}: ${issue.message}`))),
    ].join('\n'));
    return {
      path: 'wiki/dashboards/issues.md',
      title: 'Issues Dashboard',
      format: 'markdown',
      content: ['# Issues Dashboard', ...severityGroups].join('\n\n'),
      itemIds: issues.map((issue) => issue.id),
      metadata: {
        kind: 'issues-dashboard',
      },
    };
  }

  private renderBacklinksPage(limit: number): KnowledgeProjectionPage {
    const items = this.store.listSources(limit).map((source) => {
      const incoming = this.store.listEdges()
        .filter((edge) => edge.toKind === 'source' && edge.toId === source.id);
      return { source, incoming };
    }).filter((entry) => entry.incoming.length > 0);
    const content = [
      '# Backlinks Dashboard',
      '',
      ...items.map((entry) => [
        `## ${entry.source.title ?? entry.source.canonicalUri ?? entry.source.id}`,
        buildBulletList(entry.incoming.map((edge) => {
          if (edge.fromKind === 'source') {
            const linked = this.store.getSource(edge.fromId);
            return linked ? `${this.linkToTarget(this.createSourceTarget(linked))} via \`${edge.relation}\`` : `source:${edge.fromId}`;
          }
          if (edge.fromKind === 'node') {
            const node = this.store.getNode(edge.fromId);
            return node ? `${this.linkToTarget(this.createNodeTarget(node))} via \`${edge.relation}\`` : `node:${edge.fromId}`;
          }
          return `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``;
        })),
      ].join('\n')),
    ].join('\n\n');
    return {
      path: 'wiki/dashboards/backlinks.md',
      title: 'Backlinks Dashboard',
      format: 'markdown',
      content,
      itemIds: items.map((entry) => entry.source.id),
      metadata: {
        kind: 'backlinks-dashboard',
      },
    };
  }

  private renderHealthDashboardPage(limit: number): KnowledgeProjectionPage {
    const sources = this.store.listSources(limit);
    const staleThreshold = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const unhealthy = sources.filter((source) => (
      source.status !== 'indexed'
      || Boolean(source.crawlError)
      || (typeof source.lastCrawledAt === 'number' && source.lastCrawledAt < staleThreshold)
      || !this.store.getExtractionBySourceId(source.id)
    ));
    const content = [
      '# Source Health Dashboard',
      '',
      '## Sources Requiring Attention',
      buildBulletList(unhealthy.map((source) => {
        const extraction = this.store.getExtractionBySourceId(source.id);
        const notes = [
          `status=${source.status}`,
          !extraction ? 'missing extraction' : undefined,
          source.crawlError ? `error=${source.crawlError}` : undefined,
          source.lastCrawledAt && source.lastCrawledAt < staleThreshold ? 'stale' : undefined,
        ].filter(Boolean).join(', ');
        return `${this.linkToTarget(this.createSourceTarget(source))} | ${notes}`;
      })),
    ].join('\n');
    return {
      path: 'wiki/dashboards/source-health.md',
      title: 'Source Health Dashboard',
      format: 'markdown',
      content,
      itemIds: unhealthy.map((source) => source.id),
      metadata: {
        kind: 'source-health-dashboard',
      },
    };
  }

  private renderSourcePage(id: string): KnowledgeProjectionPage {
    const source = this.store.getSource(id);
    if (!source) throw new Error(`Unknown knowledge source: ${id}`);
    const extraction = this.store.getExtractionBySourceId(id);
    const view = this.store.getItem(id);
    const target = this.createSourceTarget(source);
    const relatedNodes = view?.linkedNodes ?? [];
    const relatedSources = view?.linkedSources.filter((entry) => entry.id !== source.id) ?? [];
    const issues = this.store.listIssues(10_000).filter((issue) => issue.sourceId === source.id);
    const incoming = this.store.listEdges().filter((edge) => edge.toKind === 'source' && edge.toId === source.id);
    const content = joinSections(
      `# ${target.title}`,
      extraction?.summary ?? source.summary,
      [
        '## Metadata',
        `- id: \`${source.id}\``,
        `- connector: \`${source.connectorId}\``,
        `- source type: \`${source.sourceType}\``,
        `- status: \`${source.status}\``,
        ...(source.sourceUri ? [`- source uri: ${source.sourceUri}`] : []),
        ...(source.canonicalUri ? [`- canonical uri: ${source.canonicalUri}`] : []),
        ...(source.folderPath ? [`- folder path: ${source.folderPath}`] : []),
        ...(formatDateTime(source.lastCrawledAt) ? [`- last crawled: ${formatDateTime(source.lastCrawledAt)}`] : []),
        ...(source.artifactId ? [`- artifact: \`${source.artifactId}\``] : []),
        ...(source.tags.length > 0 ? [`- tags: ${source.tags.join(', ')}`] : []),
      ].join('\n'),
      quote(source.description),
      extraction ? [
        '## Extraction',
        `- format: \`${extraction.format}\``,
        `- estimated tokens: ${extraction.estimatedTokens}`,
        ...(extraction.sections.length > 0 ? [`- sections: ${extraction.sections.join(', ')}`] : []),
        ...(extraction.links.length > 0 ? [`- links: ${extraction.links.join(', ')}`] : []),
      ].join('\n') : null,
      extraction?.excerpt ? ['## Excerpt', extraction.excerpt].join('\n') : null,
      [
        '## Related Nodes',
        buildBulletList(relatedNodes.map((node) => this.linkToTarget(this.createNodeTarget(node), `${node.title} (${node.kind})`))),
      ].join('\n'),
      [
        '## Related Sources',
        buildBulletList(relatedSources.map((entry) => this.linkToTarget(this.createSourceTarget(entry)))),
      ].join('\n'),
      [
        '## Backlinks',
        buildBulletList(incoming.map((edge) => `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``)),
      ].join('\n'),
      [
        '## Issues',
        buildBulletList(issues.map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
      [
        '## Metadata JSON',
        codeFenceJson(source.metadata),
      ].filter(Boolean).join('\n'),
      extraction ? [
        '## Extraction Structure',
        codeFenceJson(extraction.structure),
      ].filter(Boolean).join('\n') : null,
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [source.id],
      metadata: {
        sourceId: source.id,
        sourceType: source.sourceType,
        ...(extraction ? { extractionId: extraction.id } : {}),
      },
    };
  }

  private renderNodePage(id: string): KnowledgeProjectionPage {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Unknown knowledge node: ${id}`);
    const view = this.store.getItem(id);
    const target = this.createNodeTarget(node);
    const incoming = this.store.listEdges().filter((edge) => edge.toKind === 'node' && edge.toId === node.id);
    const content = joinSections(
      `# ${target.title}`,
      node.summary,
      [
        '## Metadata',
        `- id: \`${node.id}\``,
        `- kind: \`${node.kind}\``,
        `- slug: \`${node.slug}\``,
        `- status: \`${node.status}\``,
        `- confidence: ${node.confidence}`,
        ...(node.aliases.length > 0 ? [`- aliases: ${node.aliases.join(', ')}`] : []),
        ...(node.sourceId ? [`- source: \`${node.sourceId}\``] : []),
      ].join('\n'),
      [
        '## Linked Sources',
        buildBulletList((view?.linkedSources ?? []).map((source) => this.linkToTarget(this.createSourceTarget(source)))),
      ].join('\n'),
      [
        '## Linked Nodes',
        buildBulletList((view?.linkedNodes ?? []).filter((entry) => entry.id !== node.id).map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.kind})`))),
      ].join('\n'),
      [
        '## Backlinks',
        buildBulletList(incoming.map((edge) => `${edge.fromKind}:${edge.fromId} via \`${edge.relation}\``)),
      ].join('\n'),
      [
        '## Issues',
        buildBulletList(this.store.listIssues(10_000)
          .filter((issue) => issue.nodeId === node.id)
          .map((issue) => this.linkToTarget(this.createIssueTarget(issue), `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`))),
      ].join('\n'),
      [
        '## Metadata JSON',
        codeFenceJson(node.metadata),
      ].filter(Boolean).join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [node.id],
      metadata: {
        nodeId: node.id,
        kind: node.kind,
      },
    };
  }

  private renderIssuePage(id: string): KnowledgeProjectionPage {
    const issue = this.store.getIssue(id);
    if (!issue) throw new Error(`Unknown knowledge issue: ${id}`);
    const target = this.createIssueTarget(issue);
    const source = issue.sourceId ? this.store.getSource(issue.sourceId) : null;
    const node = issue.nodeId ? this.store.getNode(issue.nodeId) : null;
    const content = joinSections(
      `# ${target.title}`,
      [
        '## Metadata',
        `- id: \`${issue.id}\``,
        `- severity: \`${issue.severity}\``,
        `- code: \`${issue.code}\``,
        `- status: \`${issue.status}\``,
        ...(formatDateTime(issue.createdAt) ? [`- created: ${formatDateTime(issue.createdAt)}`] : []),
        ...(formatDateTime(issue.updatedAt) ? [`- updated: ${formatDateTime(issue.updatedAt)}`] : []),
      ].join('\n'),
      [
        '## Message',
        issue.message,
      ].join('\n'),
      [
        '## Linked Records',
        buildBulletList([
          ...(source ? [this.linkToTarget(this.createSourceTarget(source), `source: ${source.title ?? source.id}`)] : []),
          ...(node ? [this.linkToTarget(this.createNodeTarget(node), `node: ${node.title}`)] : []),
        ]),
      ].join('\n'),
      [
        '## Metadata JSON',
        codeFenceJson(issue.metadata),
      ].filter(Boolean).join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [issue.id, ...(source ? [source.id] : []), ...(node ? [node.id] : [])],
      metadata: {
        issueId: issue.id,
        severity: issue.severity,
      },
    };
  }

  private renderDashboardPage(target: KnowledgeProjectionTarget, limit: number): KnowledgeProjectionPage {
    if (target.itemId === 'backlinks') {
      return this.renderBacklinksPage(limit);
    }
    return this.renderHealthDashboardPage(limit);
  }

  private renderRollupPage(nodeId: string, target: KnowledgeProjectionTarget): KnowledgeProjectionPage {
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error(`Unknown rollup node: ${nodeId}`);
    const edges = this.store.edgesFor('node', node.id);
    const sources = edges
      .map((edge) => {
        if (edge.fromKind === 'source') return this.store.getSource(edge.fromId);
        if (edge.toKind === 'source') return this.store.getSource(edge.toId);
        return null;
      })
      .filter((source): source is KnowledgeSourceRecord => Boolean(source));
    const linkedNodes = edges
      .map((edge) => {
        if (edge.fromKind === 'node' && edge.fromId !== node.id) return this.store.getNode(edge.fromId);
        if (edge.toKind === 'node' && edge.toId !== node.id) return this.store.getNode(edge.toId);
        return null;
      })
      .filter((entry): entry is KnowledgeNodeRecord => Boolean(entry));
    const content = joinSections(
      `# ${target.title}`,
      node.summary,
      [
        '## Included Sources',
        buildBulletList(sortByTitle(dedupe(sources, (source) => source.id)).map((source) => this.linkToTarget(this.createSourceTarget(source)))),
      ].join('\n'),
      [
        '## Related Nodes',
        buildBulletList(sortByTitle(dedupe(linkedNodes, (entry) => entry.id)).map((entry) => this.linkToTarget(this.createNodeTarget(entry), `${entry.title} (${entry.kind})`))),
      ].join('\n'),
      [
        '## Metadata JSON',
        codeFenceJson(node.metadata),
      ].filter(Boolean).join('\n'),
    );
    return {
      path: target.defaultPath,
      title: target.title,
      format: 'markdown',
      content,
      itemIds: [node.id, ...sources.map((source) => source.id)],
      metadata: {
        rollupNodeId: node.id,
        kind: node.kind,
      },
    };
  }

  private renderBundleTarget(target: KnowledgeProjectionTarget, limit: number): KnowledgeProjectionBundle {
    const overview = this.renderOverviewPage(this.createPresetTarget('overview'), limit);
    const sourceIndex = this.renderSourceIndexPage(Math.max(limit * 2, 24));
    const nodeIndex = this.renderNodeIndexPage(Math.max(limit * 2, 24));
    const issueDashboard = this.renderIssueDashboardPage(Math.max(limit * 2, 24));
    const backlinks = this.renderBacklinksPage(Math.max(limit * 2, 16));
    const health = this.renderHealthDashboardPage(Math.max(limit * 2, 16));
    const pages: KnowledgeProjectionPage[] = [overview, sourceIndex, nodeIndex, issueDashboard, backlinks, health];
    const perKind = Math.max(1, Math.ceil(limit / 3));
    for (const node of this.store.listNodes(10_000).filter((entry) => entry.kind === 'domain' || entry.kind === 'topic').slice(0, 4)) {
      pages.push(this.renderRollupPage(node.id, this.createRollupTarget(node)));
    }
    for (const source of this.store.listSources(perKind)) {
      pages.push(this.renderSourcePage(source.id));
    }
    for (const node of this.store.listNodes(perKind)) {
      pages.push(this.renderNodePage(node.id));
    }
    for (const issue of this.store.listIssues(perKind)) {
      pages.push(this.renderIssuePage(issue.id));
    }
    return this.bundleFromPages(target, pages, {
      preset: 'bundle',
      sourceCount: this.store.status().sourceCount,
      nodeCount: this.store.status().nodeCount,
      issueCount: this.store.status().issueCount,
    });
  }

  private bundleFromPages(
    target: KnowledgeProjectionTarget,
    pages: readonly KnowledgeProjectionPage[],
    metadata: Record<string, unknown>,
  ): KnowledgeProjectionBundle {
    return {
      id: `projection-${slugify(target.targetId)}`,
      target,
      generatedAt: Date.now(),
      pageCount: pages.length,
      pages,
      metadata,
    };
  }

  private linkToTarget(target: KnowledgeProjectionTarget, label?: string): string {
    return `[${label ?? target.title}](${target.defaultPath})`;
  }

  private combineBundleMarkdown(bundle: KnowledgeProjectionBundle): string {
    if (bundle.pages.length === 1) {
      return bundle.pages[0]!.content;
    }
    const index = [
      `# ${bundle.target.title}`,
      `Generated: ${new Date(bundle.generatedAt).toISOString()}`,
      '',
      '## Pages',
      ...bundle.pages.map((page) => `- [${page.title}](${page.path})`),
    ].join('\n');
    const pages = bundle.pages.map((page) => [
      `## ${page.title}`,
      `Path: \`${page.path}\``,
      '',
      page.content,
    ].join('\n'));
    return [index, ...pages].join('\n\n---\n\n');
  }
}
