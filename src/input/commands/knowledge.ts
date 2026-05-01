import type { KnowledgeService } from '@pellux/goodvibes-sdk/platform/knowledge/index';
import type { CommandContext, SlashCommand } from '../command-registry.ts';

const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;

type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];
type KnowledgeAskInput = Parameters<KnowledgeService['ask']>[0];
type KnowledgeAskResult = Awaited<ReturnType<KnowledgeService['ask']>>;
type KnowledgeAskMode = NonNullable<KnowledgeAskInput['mode']>;

function requireKnowledgeApi(context: CommandContext) {
  const knowledgeApi = context.clients?.knowledgeApi;
  if (!knowledgeApi) {
    context.print('[knowledge] Knowledge API is not available in this runtime.');
    return null;
  }
  return knowledgeApi;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readStringListFlag(args: string[], name: string): string[] {
  const value = readFlag(args, name);
  if (!value) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readPositiveIntFlag(args: string[], name: string, fallback: number): number {
  const raw = readFlag(args, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readJsonObjectFlag(args: string[], name: string): Record<string, unknown> | null | undefined {
  const value = readFlag(args, name);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function positionalArgs(args: string[], valuedFlags: readonly string[] = []): string[] {
  return args.filter((token, index) => {
    if (token.startsWith('--')) return false;
    if (index > 0 && valuedFlags.includes(args[index - 1]!)) return false;
    return true;
  });
}

function requireKnowledgeAsk(context: CommandContext): ((input: KnowledgeAskInput) => Promise<KnowledgeAskResult>) | null {
  const serviceAsk = context.extensions.knowledgeService?.ask?.bind(context.extensions.knowledgeService);
  if (serviceAsk) return serviceAsk;

  const clientAsk = (context.clients?.knowledgeApi as unknown as { ask?: (input: KnowledgeAskInput) => Promise<KnowledgeAskResult> } | undefined)?.ask;
  if (clientAsk) return clientAsk;

  context.print('[knowledge] Knowledge ask is not available in this runtime.');
  return null;
}

function cleanInline(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function nodeLabel(node: { readonly kind?: string; readonly title?: string; readonly summary?: string; readonly confidence?: number }): string {
  const kind = cleanInline(node.kind) || 'node';
  const title = cleanInline(node.title) || 'untitled';
  const summary = cleanInline(node.summary);
  const confidence = typeof node.confidence === 'number' ? ` confidence=${node.confidence}` : '';
  return summary ? `[${kind}] ${title}${confidence} - ${summary}` : `[${kind}] ${title}${confidence}`;
}

function sourceLabel(source: {
  readonly id?: string;
  readonly sourceType?: string;
  readonly title?: string;
  readonly canonicalUri?: string;
  readonly sourceUri?: string;
  readonly summary?: string;
  readonly status?: string;
}): string {
  const title = cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || cleanInline(source.id) || 'untitled';
  const type = cleanInline(source.sourceType) || 'source';
  const status = cleanInline(source.status);
  const summary = cleanInline(source.summary);
  const suffix = status ? `/${status}` : '';
  return summary ? `[${type}${suffix}] ${title} - ${summary}` : `[${type}${suffix}] ${title}`;
}

function renderKnowledgeAskResult(result: KnowledgeAskResult): string {
  const answer = result.answer;
  const lines = [
    `[knowledge] ${result.query}`,
    answer.text,
    '',
    `mode: ${answer.mode}  confidence: ${answer.confidence}  synthesized: ${answer.synthesized ? 'yes' : 'no'}`,
  ];

  if (answer.sources.length > 0) {
    lines.push('', 'Sources:');
    for (const source of answer.sources) lines.push(`  - ${sourceLabel(source)}`);
  }

  if (answer.facts.length > 0) {
    lines.push('', 'Facts:');
    for (const fact of answer.facts) lines.push(`  - ${nodeLabel(fact)}`);
  }

  if (answer.linkedObjects.length > 0) {
    lines.push('', 'Linked objects:');
    for (const object of answer.linkedObjects) lines.push(`  - ${nodeLabel(object)}`);
  }

  if (answer.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of answer.gaps) lines.push(`  - ${nodeLabel(gap)}`);
  }

  return lines.join('\n');
}

export const knowledgeCommand: SlashCommand = {
  name: 'knowledge',
  aliases: ['know', 'kb'],
  description: 'Structured knowledge graph: ingest URLs/bookmarks, inspect issues, and build compact prompt packets.',
  usage: '<subcommand> [args]',
  argsHint: 'status|ask|ingest-url|import-bookmarks|import-urls|list|search|get|queue|review-issue|candidates|reports|schedules|lint|packet|explain|reindex|consolidate',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const knowledge = requireKnowledgeApi(context);
    if (!knowledge) {
      return;
    }
    if (args.length === 0 && context.openKnowledgePanel) {
      context.openKnowledgePanel();
      return;
    }
    const sub = (args[0] ?? 'status').toLowerCase();
    const rest = args.slice(1);

    switch (sub) {
      case 'ask': {
        const ask = requireKnowledgeAsk(context);
        if (!ask) return;
        const valuedFlags = ['--space', '--knowledge-space', '--limit', '--mode'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]');
          return;
        }
        const requestedMode = readFlag(rest, '--mode') as KnowledgeAskMode | undefined;
        const mode: KnowledgeAskMode = requestedMode && ['concise', 'standard', 'detailed'].includes(requestedMode)
          ? requestedMode
          : 'standard';
        const result = await ask({
          query,
          knowledgeSpaceId: readFlag(rest, '--space') ?? readFlag(rest, '--knowledge-space'),
          limit: readPositiveIntFlag(rest, '--limit', 10),
          mode,
          includeSources: true,
          includeConfidence: true,
          includeLinkedObjects: true,
        });
        context.print(renderKnowledgeAskResult(result));
        break;
      }

      case 'status': {
        const status = await knowledge.status.get();
        context.print([
          '[knowledge] Structured knowledge status',
          `  ready: ${status.ready ? 'yes' : 'no'}`,
          `  storage: ${status.storagePath}`,
          `  sources: ${status.sourceCount}`,
          `  nodes: ${status.nodeCount}`,
          `  edges: ${status.edgeCount}`,
          `  issues: ${status.issueCount}`,
        ].join('\n'));
        break;
      }

      case 'ingest-url': {
        const [url] = positionalArgs(rest, ['--title', '--tags', '--folder']);
        if (!url) {
          context.print('[knowledge] Usage: /knowledge ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]');
          return;
        }
        const result = await knowledge.ingest.url({
          url,
          title: readFlag(rest, '--title'),
          tags: readStringListFlag(rest, '--tags'),
          folderPath: readFlag(rest, '--folder'),
          sessionId: context.session.runtime.sessionId,
          sourceType: 'url',
          connectorId: 'url',
        });
        context.print(`[knowledge] Ingested ${result.source.id} ${result.source.canonicalUri ?? result.source.sourceUri ?? url}`);
        if (result.source.summary) context.print(`  ${result.source.summary}`);
        if (result.artifactId) context.print(`  artifact: ${result.artifactId}`);
        break;
      }

      case 'import-bookmarks': {
        const [path] = positionalArgs(rest);
        if (!path) {
          context.print('[knowledge] Usage: /knowledge import-bookmarks <path>');
          return;
        }
        const result = await knowledge.ingest.bookmarksFile({ path, sessionId: context.session.runtime.sessionId });
        context.print(`[knowledge] Imported bookmarks: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error: ${error}`);
        }
        break;
      }

      case 'import-urls': {
        const [path] = positionalArgs(rest);
        if (!path) {
          context.print('[knowledge] Usage: /knowledge import-urls <path>');
          return;
        }
        const result = await knowledge.ingest.urlsFile({ path, sessionId: context.session.runtime.sessionId });
        context.print(`[knowledge] Imported URL list: ${result.imported} ok, ${result.failed} failed`);
        if (result.errors.length > 0) {
          for (const error of result.errors.slice(0, 10)) context.print(`  error: ${error}`);
        }
        break;
      }

      case 'list': {
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const kind = (readFlag(rest, '--kind') ?? 'sources').toLowerCase();
        if (kind === 'nodes') {
          const nodes = knowledge.graph.nodes.list(limit);
          if (nodes.length === 0) {
            context.print('[knowledge] No nodes.');
            return;
          }
          context.print(`[knowledge] ${nodes.length} node(s):`);
          for (const node of nodes) {
            context.print(`  ${node.id} [${node.kind}] ${node.title}`);
            if (node.summary) context.print(`    ${node.summary}`);
          }
          return;
        }
        if (kind === 'issues') {
          const issues = knowledge.graph.issues.list(limit);
          if (issues.length === 0) {
            context.print('[knowledge] No issues.');
            return;
          }
          context.print(`[knowledge] ${issues.length} issue(s):`);
          for (const issue of issues) {
            context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
            context.print(`    ${issue.message}`);
          }
          return;
        }
        const sources = knowledge.sources.list(limit);
        if (sources.length === 0) {
          context.print('[knowledge] No sources.');
          return;
        }
        context.print(`[knowledge] ${sources.length} source(s):`);
        for (const source of sources) {
          context.print(`  ${source.id} [${source.sourceType}/${source.status}] ${source.title ?? source.canonicalUri ?? source.sourceUri ?? 'untitled'}`);
          if (source.summary) context.print(`    ${source.summary}`);
        }
        break;
      }

      case 'search': {
        const valuedFlags = ['--limit'];
        const query = positionalArgs(rest, valuedFlags).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge search <query> [--limit <n>]');
          return;
        }
        const limit = Math.max(1, Number.parseInt(readFlag(rest, '--limit') ?? '10', 10) || 10);
        const results = knowledge.graph.items.search(query, limit);
        if (results.length === 0) {
          context.print('[knowledge] No results.');
          return;
        }
        context.print(`[knowledge] ${results.length} result(s):`);
        for (const result of results) {
          const title = result.source?.title ?? result.source?.canonicalUri ?? result.node?.title ?? result.id;
          context.print(`  ${result.id} [${result.kind}] score=${result.score} ${title}`);
          context.print(`    ${result.reason}`);
        }
        break;
      }

      case 'get': {
        const [id] = positionalArgs(rest);
        if (!id) {
          context.print('[knowledge] Usage: /knowledge get <id>');
          return;
        }
        const item = knowledge.graph.items.get(id);
        if (!item) {
          context.print(`[knowledge] Unknown item: ${id}`);
          return;
        }
        if (item.source) {
          context.print(`[knowledge] source ${item.source.id}`);
          context.print(`  title: ${item.source.title ?? 'untitled'}`);
          context.print(`  uri: ${item.source.canonicalUri ?? item.source.sourceUri ?? 'n/a'}`);
          context.print(`  status: ${item.source.status}`);
          if (item.source.summary) context.print(`  summary: ${item.source.summary}`);
        } else if (item.node) {
          context.print(`[knowledge] node ${item.node.id}`);
          context.print(`  kind: ${item.node.kind}`);
          context.print(`  title: ${item.node.title}`);
          if (item.node.summary) context.print(`  summary: ${item.node.summary}`);
        } else if (item.issue) {
          context.print(`[knowledge] issue ${item.issue.id}`);
          context.print(`  severity: ${item.issue.severity}`);
          context.print(`  code: ${item.issue.code}`);
          context.print(`  message: ${item.issue.message}`);
        }
        if (item.relatedEdges.length > 0) {
          context.print('  relations:');
          for (const edge of item.relatedEdges.slice(0, 12)) {
            context.print(`    ${edge.fromKind}:${edge.fromId} -[${edge.relation}]-> ${edge.toKind}:${edge.toId}`);
          }
        }
        break;
      }

      case 'lint': {
        const issues = await knowledge.status.lint();
        if (issues.length === 0) {
          context.print('[knowledge] No lint issues.');
          return;
        }
        context.print(`[knowledge] ${issues.length} lint issue(s):`);
        for (const issue of issues) {
          context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          context.print(`    ${issue.message}`);
        }
        break;
      }

      case 'queue': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const issues = knowledge.graph.issues.list(limit);
        if (issues.length === 0) {
          context.print('Knowledge review queue is empty.');
          return;
        }
        context.print(`[knowledge] Review queue (${issues.length}):`);
        for (const issue of issues) {
          context.print(`  ${issue.id} [${issue.severity}] ${issue.code}`);
          context.print(`    ${issue.message}`);
        }
        break;
      }

      case 'review-issue':
      case 'issue-review': {
        const [issueId, actionValue] = positionalArgs(rest, ['--reviewer', '--value']);
        const action = actionValue?.toLowerCase();
        if (!issueId || !action || !KNOWLEDGE_REVIEW_ACTIONS.includes(action as KnowledgeReviewAction)) {
          context.print('[knowledge] Usage: /knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]');
          return;
        }
        const value = readJsonObjectFlag(rest, '--value');
        if (value === null) {
          context.print('[knowledge] --value must be a JSON object.');
          return;
        }
        try {
          const result = await knowledge.graph.issues.review({
            issueId,
            action: action as KnowledgeReviewAction,
            reviewer: readFlag(rest, '--reviewer') ?? 'tui',
            ...(value ? { value } : {}),
          });
          context.print([
            `[knowledge] Reviewed issue ${result.issue.id}`,
            `  action: ${action}`,
            `  status: ${result.issue.status}`,
            ...(result.node ? [`  node: ${result.node.id} ${result.node.title}`] : []),
            ...(result.source ? [`  source: ${result.source.id} ${result.source.title ?? result.source.canonicalUri ?? result.source.sourceUri ?? 'untitled'}`] : []),
            ...(result.appliedFacts ? [`  applied facts: ${Object.keys(result.appliedFacts).join(', ') || 'none'}`] : []),
          ].join('\n'));
        } catch (error) {
          context.print(`[knowledge] ${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }

      case 'candidates': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const candidates = knowledge.consolidation.candidates(limit);
        if (candidates.length === 0) {
          context.print('[knowledge] No consolidation candidates.');
          return;
        }
        context.print(`[knowledge] Consolidation candidates (${candidates.length}):`);
        for (const candidate of candidates) {
          context.print(`  ${candidate.id} [${candidate.status}] score=${candidate.score} ${candidate.title}`);
          context.print(`    ${candidate.candidateType}`);
        }
        break;
      }

      case 'reports': {
        const [limitArg] = positionalArgs(rest);
        const limit = Math.max(1, Number.parseInt(limitArg ?? '10', 10) || 10);
        const reports = knowledge.consolidation.reports(limit);
        if (reports.length === 0) {
          context.print('[knowledge] No consolidation reports.');
          return;
        }
        context.print(`[knowledge] Consolidation reports (${reports.length}):`);
        for (const report of reports) {
          context.print(`  ${report.id} [${report.kind}] ${report.title}`);
          context.print(`    ${report.summary}`);
        }
        break;
      }

      case 'schedules': {
        const schedules = knowledge.jobs.schedules.list(20);
        if (schedules.length === 0) {
          context.print('[knowledge] No knowledge schedules.');
          return;
        }
        context.print(`[knowledge] Managed schedules (${schedules.length}):`);
        for (const schedule of schedules) {
          context.print(`  ${schedule.id} [${schedule.enabled ? 'enabled' : 'disabled'}] ${schedule.jobId}`);
          context.print(`    ${schedule.label}`);
        }
        break;
      }

      case 'packet': {
        const scopeValues: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '--scope' && rest[index + 1]) {
            scopeValues.push(rest[index + 1]!);
            index += 1;
          }
        }
        const query = positionalArgs(rest, ['--scope']).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge packet <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        context.print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'explain': {
        const scopeValues: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          if (rest[index] === '--scope' && rest[index + 1]) {
            scopeValues.push(rest[index + 1]!);
            index += 1;
          }
        }
        const query = positionalArgs(rest, ['--scope']).join(' ').trim();
        if (!query) {
          context.print('[knowledge] Usage: /knowledge explain <task...> [--scope <path> ...]');
          return;
        }
        const prompt = await knowledge.packets.buildPrompt(query, scopeValues);
        context.print(prompt ?? '[knowledge] No structured knowledge matched that task.');
        break;
      }

      case 'reindex': {
        const result = await knowledge.status.reindex();
        context.print([
          '[knowledge] Reindex complete',
          `  sources: ${result.status.sourceCount}`,
          `  nodes: ${result.status.nodeCount}`,
          `  edges: ${result.status.edgeCount}`,
          `  issues: ${result.status.issueCount}`,
        ].join('\n'));
        break;
      }

      case 'consolidate': {
        const mode = (positionalArgs(rest)[0] ?? 'light').toLowerCase();
        const jobId = mode === 'deep' ? 'knowledge-deep-consolidation' : 'knowledge-light-consolidation';
        const run = await knowledge.jobs.run(jobId, { mode: 'inline' });
        context.print(`[knowledge] Consolidation run ${run.id} finished with status ${run.status}.`);
        break;
      }

      default:
        context.print([
          'Usage: /knowledge <subcommand>',
          '  status',
          '  ask <query> [--space <knowledgeSpaceId>] [--limit <n>] [--mode <concise|standard|detailed>]',
          '  ingest-url <url> [--title <title>] [--tags <a,b>] [--folder <path>]',
          '  import-bookmarks <path>',
          '  import-urls <path>',
          '  list [--kind <sources|nodes|issues>] [--limit <n>]',
          '  search <query> [--limit <n>]',
          '  get <id>',
          '  queue [limit]',
          '  review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> [--reviewer <name>] [--value <json-object>]',
          '  candidates [limit]',
          '  reports [limit]',
          '  schedules',
          '  lint',
          '  packet <task...> [--scope <path> ...]',
          '  explain <task...> [--scope <path> ...]',
          '  reindex',
          '  consolidate [light|deep]',
        ].join('\n'));
    }
  },
};
