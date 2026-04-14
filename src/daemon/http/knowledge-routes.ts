import {
  inspectKnowledgeGraphqlAccess,
  type KnowledgeConsolidationCandidateRecord,
  type KnowledgePacket,
  type KnowledgeProjectionTargetKind,
  type KnowledgeScheduleRecord,
  type KnowledgeService,
  type KnowledgeSourceRecord,
  type KnowledgeUsageRecord,
} from '../../knowledge/index.ts';
import type { KnowledgeGraphqlService } from '../../knowledge/index.ts';
import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationScheduleDefinition,
} from '../../automation/index.ts';
import type { DaemonApiRouteHandlers } from '../../control-plane/routes/context.ts';
import type { ConfigKey } from '../../config/schema.ts';
import { summarizeError } from '../../utils/error-display.ts';
import {
  buildMissingScopeBody,
  resolveAuthenticatedPrincipal,
  resolvePrivateHostFetchOptions,
  type AuthenticatedPrincipal,
} from '../http-policy.ts';
import { jsonErrorResponse } from './error-response.ts';

type JsonBody = Record<string, unknown>;

interface DaemonKnowledgeRouteContext {
  readonly configManager: { get(key: ConfigKey): unknown };
  readonly parseJsonBody: (req: Request) => Promise<JsonBody | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonBody | null | Response>;
  readonly parseJsonText: (raw: string) => JsonBody | Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly describeAuthenticatedPrincipal: (token: string) => AuthenticatedPrincipal | null;
  readonly extractAuthToken: (req: Request) => string;
  readonly knowledgeService: KnowledgeService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
}

export function createDaemonKnowledgeRouteHandlers(
  context: DaemonKnowledgeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'getKnowledgeStatus'
  | 'getKnowledgeSources'
  | 'getKnowledgeNodes'
  | 'getKnowledgeIssues'
  | 'getKnowledgeItem'
  | 'getKnowledgeConnectors'
  | 'getKnowledgeConnector'
  | 'getKnowledgeConnectorDoctor'
  | 'getKnowledgeProjectionTargets'
  | 'getKnowledgeGraphqlSchema'
  | 'getKnowledgeExtractions'
  | 'getKnowledgeUsage'
  | 'getKnowledgeCandidates'
  | 'getKnowledgeCandidate'
  | 'getKnowledgeReports'
  | 'getKnowledgeReport'
  | 'getKnowledgeExtraction'
  | 'getKnowledgeSourceExtraction'
  | 'getKnowledgeJobs'
  | 'getKnowledgeJob'
  | 'getKnowledgeJobRuns'
  | 'getKnowledgeSchedules'
  | 'getKnowledgeSchedule'
  | 'postKnowledgeIngestUrl'
  | 'postKnowledgeIngestArtifact'
  | 'postKnowledgeImportBookmarks'
  | 'postKnowledgeImportUrls'
  | 'postKnowledgeIngestConnector'
  | 'postKnowledgeSearch'
  | 'postKnowledgePacket'
  | 'postKnowledgeDecideCandidate'
  | 'postKnowledgeRunJob'
  | 'postKnowledgeLint'
  | 'postKnowledgeReindex'
  | 'postKnowledgeSaveSchedule'
  | 'deleteKnowledgeSchedule'
  | 'postKnowledgeSetScheduleEnabled'
  | 'postKnowledgeRenderProjection'
  | 'postKnowledgeMaterializeProjection'
  | 'executeKnowledgeGraphql'
> {
  return {
    getKnowledgeStatus: async () => Response.json(await context.knowledgeService.getStatus()),
    getKnowledgeSources: async (url) => Response.json({ sources: context.knowledgeService.listSources(readLimit(url, 100)) }),
    getKnowledgeNodes: async (url) => Response.json({ nodes: context.knowledgeService.listNodes(readLimit(url, 100)) }),
    getKnowledgeIssues: async (url) => Response.json({ issues: context.knowledgeService.listIssues(readLimit(url, 100)) }),
    getKnowledgeItem: (id) => {
      const item = context.knowledgeService.getItem(id);
      return item
        ? Response.json(item)
        : Response.json({ error: 'Unknown knowledge item' }, { status: 404 });
    },
    getKnowledgeConnectors: () => Response.json({ connectors: context.knowledgeService.listConnectors() }),
    getKnowledgeConnector: (id) => {
      const connector = context.knowledgeService.getConnector(id);
      return connector
        ? Response.json({ connector })
        : Response.json({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeConnectorDoctor: async (id) => {
      const report = await context.knowledgeService.doctorConnector(id);
      return report
        ? Response.json({ report })
        : Response.json({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeProjectionTargets: async (url) => Response.json({ targets: await context.knowledgeService.listProjectionTargets(readLimit(url, 25)) }),
    getKnowledgeGraphqlSchema: () => Response.json({
      language: 'graphql',
      domain: 'knowledge',
      schema: context.knowledgeGraphqlService.schemaText,
    }),
    getKnowledgeExtractions: async (url) => {
      const sourceId = url.searchParams.get('sourceId') ?? undefined;
      return Response.json({ extractions: context.knowledgeService.listExtractions(readLimit(url, 100), sourceId) });
    },
    getKnowledgeUsage: async (url) => {
      const targetKind = url.searchParams.get('targetKind') ?? undefined;
      const targetId = url.searchParams.get('targetId') ?? undefined;
      const usageKind = url.searchParams.get('usageKind') ?? undefined;
      return Response.json({
        usage: context.knowledgeService.listUsageRecords(readLimit(url, 100), {
          ...(targetKind ? { targetKind: targetKind as 'source' | 'node' | 'issue' } : {}),
          ...(targetId ? { targetId } : {}),
          ...(usageKind ? { usageKind: usageKind as KnowledgeUsageRecord['usageKind'] } : {}),
        }),
      });
    },
    getKnowledgeCandidates: async (url) => {
      const status = url.searchParams.get('status') ?? undefined;
      const subjectKind = url.searchParams.get('subjectKind') ?? undefined;
      const subjectId = url.searchParams.get('subjectId') ?? undefined;
      return Response.json({
        candidates: context.knowledgeService.listConsolidationCandidates(readLimit(url, 100), {
          ...(status ? { status: status as KnowledgeConsolidationCandidateRecord['status'] } : {}),
          ...(subjectKind ? { subjectKind: subjectKind as 'source' | 'node' | 'issue' } : {}),
          ...(subjectId ? { subjectId } : {}),
        }),
      });
    },
    getKnowledgeCandidate: (id) => {
      const candidate = context.knowledgeService.getConsolidationCandidate(id);
      return candidate
        ? Response.json({ candidate })
        : Response.json({ error: 'Unknown knowledge consolidation candidate' }, { status: 404 });
    },
    getKnowledgeReports: async (url) => Response.json({ reports: context.knowledgeService.listConsolidationReports(readLimit(url, 100)) }),
    getKnowledgeReport: (id) => {
      const report = context.knowledgeService.getConsolidationReport(id);
      return report
        ? Response.json({ report })
        : Response.json({ error: 'Unknown knowledge consolidation report' }, { status: 404 });
    },
    getKnowledgeExtraction: (id) => {
      const extraction = context.knowledgeService.getExtraction(id);
      return extraction
        ? Response.json({ extraction })
        : Response.json({ error: 'Unknown knowledge extraction' }, { status: 404 });
    },
    getKnowledgeSourceExtraction: (id) => {
      const extraction = context.knowledgeService.getSourceExtraction(id);
      return extraction
        ? Response.json({ extraction })
        : Response.json({ error: 'Unknown source extraction' }, { status: 404 });
    },
    getKnowledgeJobs: () => Response.json({ jobs: context.knowledgeService.listJobs() }),
    getKnowledgeJob: (jobId) => {
      const job = context.knowledgeService.getJob(jobId);
      return job
        ? Response.json({ job })
        : Response.json({ error: 'Unknown knowledge job' }, { status: 404 });
    },
    getKnowledgeJobRuns: (url) => {
      const jobId = url.searchParams.get('jobId') ?? undefined;
      return Response.json({ runs: context.knowledgeService.listJobRuns(readLimit(url, 25), jobId) });
    },
    getKnowledgeSchedules: (url) => Response.json({ schedules: context.knowledgeService.listSchedules(readLimit(url, 100)) }),
    getKnowledgeSchedule: (id) => {
      const schedule = context.knowledgeService.getSchedule(id);
      return schedule
        ? Response.json({ schedule })
        : Response.json({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeIngestUrl: async (request) => handleKnowledgeIngestUrl(context, request),
    postKnowledgeIngestArtifact: async (request) => handleKnowledgeIngestArtifact(context, request),
    postKnowledgeImportBookmarks: async (request) => handleKnowledgeImportBookmarks(context, request),
    postKnowledgeImportUrls: async (request) => handleKnowledgeImportUrls(context, request),
    postKnowledgeIngestConnector: async (request) => handleKnowledgeIngestConnector(context, request),
    postKnowledgeSearch: async (request) => handleKnowledgeSearch(context, request),
    postKnowledgePacket: async (request) => handleKnowledgePacket(context, request),
    postKnowledgeDecideCandidate: async (id, request) => handleKnowledgeDecideCandidate(context, id, request),
    postKnowledgeRunJob: async (jobId, request) => handleKnowledgeRunJob(context, jobId, request),
    postKnowledgeLint: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json({ issues: await context.knowledgeService.lint() });
    },
    postKnowledgeReindex: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(await context.knowledgeService.reindex());
    },
    postKnowledgeSaveSchedule: async (request) => handleKnowledgeSaveSchedule(context, request),
    deleteKnowledgeSchedule: async (id, request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      const deleted = await context.knowledgeService.deleteSchedule(id);
      return deleted
        ? Response.json({ deleted: true })
        : Response.json({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeSetScheduleEnabled: async (id, request) => handleKnowledgeSetScheduleEnabled(context, id, request),
    postKnowledgeRenderProjection: async (request) => handleKnowledgeRenderProjection(context, request),
    postKnowledgeMaterializeProjection: async (request) => handleKnowledgeMaterializeProjection(context, request),
    executeKnowledgeGraphql: async (request) => handleKnowledgeGraphql(context, request),
  };
}

function readLimit(url: URL, fallback: number): number {
  return Math.max(1, Number(url.searchParams.get('limit') ?? fallback) || fallback);
}

function readKnowledgeProjectionRequest(
  body: JsonBody,
): { kind: KnowledgeProjectionTargetKind; id?: string; limit?: number } | Response {
  const rawKind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (
    rawKind !== 'overview'
    && rawKind !== 'bundle'
    && rawKind !== 'source'
    && rawKind !== 'node'
    && rawKind !== 'issue'
  ) {
    return Response.json({ error: 'Projection kind must be one of overview, bundle, source, node, or issue.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if ((rawKind === 'source' || rawKind === 'node' || rawKind === 'issue') && !id) {
    return Response.json({ error: `Projection kind ${rawKind} requires id.` }, { status: 400 });
  }
  return {
    kind: rawKind,
    ...(id ? { id } : {}),
    ...(typeof body.limit === 'number' ? { limit: Math.max(1, body.limit) } : {}),
  };
}

function readKnowledgeSchedule(value: unknown): AutomationScheduleDefinition | Response {
  if (typeof value !== 'object' || value === null) {
    return Response.json({ error: 'Missing schedule object' }, { status: 400 });
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === 'string' ? schedule.kind.trim().toLowerCase() : '';
  try {
    switch (kind) {
      case 'every':
        if (typeof schedule.intervalMs === 'number') {
          return normalizeEverySchedule(schedule.intervalMs, typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined);
        }
        if (typeof schedule.interval === 'string') {
          return normalizeEverySchedule(schedule.interval, typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined);
        }
        throw new Error('Every schedule requires intervalMs or interval.');
      case 'cron':
        if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) {
          throw new Error('Cron schedule requires expression.');
        }
        return normalizeCronSchedule(
          schedule.expression,
          typeof schedule.timezone === 'string' ? schedule.timezone : undefined,
          schedule.staggerMs,
        );
      case 'at':
        if (typeof schedule.at !== 'number') throw new Error('At schedule requires at.');
        return normalizeAtSchedule(schedule.at);
      default:
        throw new Error('Schedule kind must be at, every, or cron.');
    }
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

function readGraphqlVariables(
  value: unknown,
  parseJsonText: DaemonKnowledgeRouteContext['parseJsonText'],
): Record<string, unknown> | Response | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const parsed = parseJsonText(value);
    if (parsed instanceof Response) return parsed;
    return parsed;
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return Response.json({ error: 'GraphQL variables must be an object or JSON string.' }, { status: 400 });
}

async function parseKnowledgeGraphqlRequest(
  context: DaemonKnowledgeRouteContext,
  req: Request,
): Promise<{ query: string; operationName?: string; variables?: Record<string, unknown> } | Response> {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const query = url.searchParams.get('query')?.trim() ?? '';
    if (!query) return Response.json({ error: 'Missing query' }, { status: 400 });
    const variables = readGraphqlVariables(url.searchParams.get('variables'), context.parseJsonText);
    if (variables instanceof Response) return variables;
    const operationName = url.searchParams.get('operationName')?.trim();
    return {
      query,
      ...(operationName ? { operationName } : {}),
      ...(variables ? { variables } : {}),
    };
  }

  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.startsWith('application/graphql')) {
    const query = (await req.text()).trim();
    return query
      ? { query }
      : Response.json({ error: 'Missing query' }, { status: 400 });
  }

  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  if (!body) return Response.json({ error: 'Missing query' }, { status: 400 });
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return Response.json({ error: 'Missing query' }, { status: 400 });
  const variables = readGraphqlVariables(body.variables, context.parseJsonText);
  if (variables instanceof Response) return variables;
  const operationName = typeof body.operationName === 'string' ? body.operationName.trim() : '';
  return {
    query,
    ...(operationName ? { operationName } : {}),
    ...(variables ? { variables } : {}),
  };
}

async function handleKnowledgeGraphql(context: DaemonKnowledgeRouteContext, req: Request): Promise<Response> {
  const parsed = await parseKnowledgeGraphqlRequest(context, req);
  if (parsed instanceof Response) return parsed;
  if (req.method === 'GET' && /\bmutation\b/.test(parsed.query)) {
    return Response.json({ error: 'GraphQL mutations must use POST.' }, { status: 405 });
  }
  const principal = resolveAuthenticatedPrincipal(req, context);
  if (!principal) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let access;
  try {
    access = inspectKnowledgeGraphqlAccess(parsed.query, parsed.operationName);
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }

  const scopeDenied = buildMissingScopeBody('knowledge GraphQL operation', access.requiredScopes, principal.scopes);
  if (scopeDenied) {
    return Response.json(scopeDenied, { status: 403 });
  }
  if (access.adminRequired && !principal.admin) {
    return Response.json({ error: 'Knowledge GraphQL mutation requires admin access.' }, { status: 403 });
  }

  const result = await context.knowledgeGraphqlService.execute({
    query: parsed.query,
    ...(parsed.operationName ? { operationName: parsed.operationName } : {}),
    ...(parsed.variables ? { variables: parsed.variables } : {}),
    admin: principal.admin,
    scopes: principal.scopes,
  });
  const status = result.errors?.length && !result.data ? 400 : 200;
  return Response.json(result, { status });
}

function buildKnowledgePrivateHostFetchOptions(
  context: DaemonKnowledgeRouteContext,
  requested: unknown,
): { allowPrivateHosts: true } | {} | Response {
  return resolvePrivateHostFetchOptions(requested, {
    configManager: context.configManager,
  });
}

async function handleKnowledgeIngestUrl(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return Response.json({ error: 'Missing url' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.ingestUrl({
      url,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.sourceType === 'string' ? { sourceType: body.sourceType as KnowledgeSourceRecord['sourceType'] } : {}),
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...privateHostFetchOptions,
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeIngestArtifact(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.ingestArtifact({
      ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.uri === 'string' ? { uri: body.uri } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.filter((entry): entry is string => typeof entry === 'string') } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.sourceType === 'string' ? { sourceType: body.sourceType as KnowledgeSourceRecord['sourceType'] } : {}),
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...privateHostFetchOptions,
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeImportBookmarks(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return Response.json({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importBookmarksFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...privateHostFetchOptions,
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeImportUrls(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return Response.json({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importUrlsFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...privateHostFetchOptions,
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeIngestConnector(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const connectorId = typeof body.connectorId === 'string' ? body.connectorId.trim() : '';
  if (!connectorId) return Response.json({ error: 'Missing connectorId' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.ingestConnectorInput({
      connectorId,
      ...(Object.hasOwn(body, 'input') ? { input: body.input } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...privateHostFetchOptions,
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeSearch(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return Response.json({ error: 'Missing query' }, { status: 400 });
  const limit = typeof body.limit === 'number' ? body.limit : 10;
  return Response.json({ results: context.knowledgeService.search(query, limit) });
}

async function handleKnowledgePacket(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const task = typeof body.task === 'string' ? body.task.trim() : '';
  if (!task) return Response.json({ error: 'Missing task' }, { status: 400 });
  const writeScope = Array.isArray(body.writeScope) ? body.writeScope.filter((entry): entry is string => typeof entry === 'string') : [];
  const limit = typeof body.limit === 'number' ? body.limit : 6;
  const detail = typeof body.detail === 'string' ? body.detail.toLowerCase() as KnowledgePacket['detail'] : undefined;
  const budgetLimit = typeof body.budgetLimit === 'number' ? body.budgetLimit : undefined;
  return Response.json(await context.knowledgeService.buildPacket(task, writeScope, limit, {
    ...(detail ? { detail } : {}),
    ...(typeof budgetLimit === 'number' ? { budgetLimit } : {}),
  }));
}

async function handleKnowledgeDecideCandidate(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  if (decision !== 'accept' && decision !== 'reject' && decision !== 'supersede') {
    return Response.json({ error: 'Decision must be accept, reject, or supersede.' }, { status: 400 });
  }
  try {
    return Response.json({
      candidate: await context.knowledgeService.decideConsolidationCandidate(id, decision, {
        ...(typeof body.decidedBy === 'string' ? { decidedBy: body.decidedBy } : {}),
        ...(typeof body.memoryClass === 'string' ? { memoryClass: body.memoryClass } : {}),
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      }),
    });
  } catch (error) {
    const message = summarizeError(error);
    return jsonErrorResponse(error, {
      status: message.startsWith('Unknown knowledge consolidation candidate:') ? 404 : 400,
    });
  }
}

async function handleKnowledgeRunJob(context: DaemonKnowledgeRouteContext, jobId: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  try {
    return Response.json({
      run: await context.knowledgeService.runJob(jobId, {
        ...(typeof body.mode === 'string' ? { mode: body.mode.toLowerCase() as 'inline' | 'background' } : {}),
        ...(Array.isArray(body.sourceIds) ? { sourceIds: body.sourceIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      }),
    });
  } catch (error) {
    const message = summarizeError(error);
    return jsonErrorResponse(error, {
      status: message.startsWith('Unknown knowledge job:') ? 404 : 400,
    });
  }
}

async function handleKnowledgeSaveSchedule(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 });
  const schedule = readKnowledgeSchedule(body.schedule);
  if (schedule instanceof Response) return schedule;
  try {
    return Response.json({
      schedule: await context.knowledgeService.saveSchedule({
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        jobId,
        schedule,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      }),
    }, { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeSetScheduleEnabled(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'Missing enabled boolean' }, { status: 400 });
  }
  const schedule = await context.knowledgeService.setScheduleEnabled(id, body.enabled);
  return schedule
    ? Response.json({ schedule })
    : Response.json({ error: 'Unknown knowledge schedule' }, { status: 404 });
}

async function handleKnowledgeRenderProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  try {
    return Response.json(await context.knowledgeService.renderProjection(parsed));
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}

async function handleKnowledgeMaterializeProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  try {
    return Response.json(await context.knowledgeService.materializeProjection({
      ...parsed,
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
    }), { status: 201 });
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
}
