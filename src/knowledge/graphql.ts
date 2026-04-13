import { GraphQLError, buildSchema, graphql, parse, printSchema } from 'graphql';
import type { KnowledgeService } from './service.ts';
import {
  KNOWLEDGE_GRAPHQL_SDL,
  clampInt,
  clampOffset,
  installJsonScalar,
  mapJob,
  mapJobRun,
  mapPacket,
  mapProjectionBundle,
  mapProjectionTarget,
  pickOperation,
  toJobMode,
  toPacketDetail,
  toProjectionKind,
} from './graphql-schema.ts';

export interface KnowledgeGraphqlAccessProfile {
  readonly operation: 'query' | 'mutation';
  readonly requiredScopes: readonly string[];
  readonly adminRequired: boolean;
}

export function inspectKnowledgeGraphqlAccess(
  source: string,
  operationName?: string,
): KnowledgeGraphqlAccessProfile {
  const document = parse(source);
  const operation = pickOperation(document, operationName);
  return operation === 'mutation'
    ? { operation, requiredScopes: ['write:knowledge'], adminRequired: true }
    : { operation, requiredScopes: ['read:knowledge'], adminRequired: false };
}

interface KnowledgeGraphqlContext {
  readonly service: KnowledgeService;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

function assertWriteAccess(context: KnowledgeGraphqlContext): void {
  if (!context.admin) {
    throw new GraphQLError('Knowledge GraphQL mutation requires admin access.');
  }
  if (!context.scopes.includes('write:knowledge')) {
    throw new GraphQLError('Knowledge GraphQL mutation requires write:knowledge.');
  }
}

export interface KnowledgeGraphqlExecuteInput {
  readonly query: string;
  readonly operationName?: string;
  readonly variables?: Record<string, unknown>;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

export class KnowledgeGraphqlService {
  private static readonly schema = (() => {
    const schema = buildSchema(KNOWLEDGE_GRAPHQL_SDL);
    installJsonScalar(schema);
    return schema;
  })();

  private static readonly schemaSdl = printSchema(KnowledgeGraphqlService.schema);

  constructor(private readonly service: KnowledgeService) {}

  get schemaText(): string {
    return KnowledgeGraphqlService.schemaSdl;
  }

  async execute(input: KnowledgeGraphqlExecuteInput) {
    const rootValue = this.createRootValue();
    const context: KnowledgeGraphqlContext = {
      service: this.service,
      admin: input.admin,
      scopes: [...input.scopes],
    };
    const result = await graphql({
      schema: KnowledgeGraphqlService.schema,
      source: input.query,
      rootValue,
      contextValue: context,
      variableValues: input.variables,
      operationName: input.operationName,
    });
    return result;
  }

  private createRootValue() {
    return {
      status: async () => this.service.getStatus(),
      sources: ({ limit }: { limit?: number }) => this.service.listSources(clampInt(limit, 100)),
      nodes: ({ limit }: { limit?: number }) => this.service.listNodes(clampInt(limit, 100)),
      issues: ({ limit }: { limit?: number }) => this.service.listIssues(clampInt(limit, 100)),
      source: ({ id }: { id: string }) => this.service.listSources(10_000).find((source) => source.id === id) ?? null,
      node: ({ id }: { id: string }) => this.service.listNodes(10_000).find((node) => node.id === id) ?? null,
      issue: ({ id }: { id: string }) => this.service.listIssues(10_000).find((issue) => issue.id === id) ?? null,
      item: ({ id }: { id: string }) => this.service.getItem(id),
      items: ({ ids }: { ids: string[] }) => this.service.getItems(ids),
      sourcesConnection: (args: {
        limit?: number;
        offset?: number;
        status?: string;
        connectorId?: string;
        sourceType?: string;
        tag?: string;
        query?: string;
      }) => this.service.querySources({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        status: args.status,
        connectorId: args.connectorId,
        sourceType: args.sourceType,
        tag: args.tag,
        query: args.query,
      }),
      nodesConnection: (args: { limit?: number; offset?: number; kind?: string; status?: string; query?: string }) => this.service.queryNodes({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        kind: args.kind,
        status: args.status,
        query: args.query,
      }),
      issuesConnection: (args: { limit?: number; offset?: number; severity?: string; status?: string; code?: string; query?: string }) => this.service.queryIssues({
        limit: clampInt(args.limit, 100),
        offset: clampOffset(args.offset),
        severity: args.severity,
        status: args.status,
        code: args.code,
        query: args.query,
      }),
      extractions: ({ limit, sourceId }: { limit?: number; sourceId?: string }) => this.service.listExtractions(clampInt(limit, 100), sourceId),
      sourceExtraction: ({ sourceId }: { sourceId: string }) => this.service.getSourceExtraction(sourceId),
      neighbors: ({ kind, id, relation, limit }: { kind: 'source' | 'node'; id: string; relation?: string; limit?: number }) => {
        if (kind !== 'source' && kind !== 'node') {
          throw new GraphQLError(`Unsupported knowledge neighbor kind: ${kind}`);
        }
        return this.service.getNeighbors(kind, id, { relation, limit: clampInt(limit, 20) });
      },
      search: ({ query, limit }: { query: string; limit?: number }) => this.service.search(query, clampInt(limit, 10)),
      packet: async ({ task, writeScope, limit, detail, budgetLimit }: { task: string; writeScope?: string[]; limit?: number; detail?: string; budgetLimit?: number }) => mapPacket(await this.service.buildPacket(
        task,
        writeScope ?? [],
        clampInt(limit, 6),
        {
          detail: toPacketDetail(detail),
          ...(typeof budgetLimit === 'number' ? { budgetLimit } : {}),
        },
      )),
      connectors: () => this.service.listConnectors(),
      connector: ({ id }: { id: string }) => this.service.getConnector(id),
      connectorDoctor: ({ id }: { id: string }) => this.service.doctorConnector(id),
      projectionTargets: async ({ limit }: { limit?: number }) => (await this.service.listProjectionTargets(clampInt(limit, 25))).map((target) => mapProjectionTarget(target)),
      projection: async ({ kind, id, limit }: { kind: string; id?: string; limit?: number }) => mapProjectionBundle(await this.service.renderProjection({
        kind: toProjectionKind(kind),
        id,
        limit: clampInt(limit, 12),
      })),
      jobs: () => this.service.listJobs().map((job) => mapJob(job)),
      job: ({ id }: { id: string }) => {
        const job = this.service.getJob(id);
        return job ? mapJob(job) : null;
      },
      jobRuns: ({ limit, jobId }: { limit?: number; jobId?: string }) => this.service.listJobRuns(clampInt(limit, 25), jobId).map((run) => mapJobRun(run)),
      usage: ({ limit, targetKind, targetId, usageKind }: { limit?: number; targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: string }) => (
        this.service.listUsageRecords(clampInt(limit, 100), {
          ...(targetKind ? { targetKind } : {}),
          ...(targetId ? { targetId } : {}),
          ...(usageKind ? { usageKind: usageKind as 'search-hit' | 'packet-item' | 'item-open' | 'neighbor-open' | 'projection-read' | 'multimodal-writeback' } : {}),
        })
      ),
      consolidationCandidates: ({ limit, status, subjectKind, subjectId }: { limit?: number; status?: string; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string }) => (
        this.service.listConsolidationCandidates(clampInt(limit, 100), {
          ...(status ? { status: status as 'open' | 'accepted' | 'rejected' | 'superseded' } : {}),
          ...(subjectKind ? { subjectKind } : {}),
          ...(subjectId ? { subjectId } : {}),
        })
      ),
      consolidationCandidate: ({ id }: { id: string }) => this.service.getConsolidationCandidate(id),
      consolidationReports: ({ limit }: { limit?: number }) => this.service.listConsolidationReports(clampInt(limit, 100)),
      consolidationReport: ({ id }: { id: string }) => this.service.getConsolidationReport(id),
      schedules: ({ limit }: { limit?: number }) => this.service.listSchedules(clampInt(limit, 100)),
      schedule: ({ id }: { id: string }) => this.service.getSchedule(id),
      ingestUrl: async (
        args: {
          url: string;
          title?: string;
          tags?: string[];
          folderPath?: string;
          sessionId?: string;
          sourceType?: string;
          connectorId?: string;
          allowPrivateHosts?: boolean;
          metadata?: Record<string, unknown>;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestUrl({
          url: args.url,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestUrl']>[0]['sourceType'],
          connectorId: args.connectorId,
          allowPrivateHosts: args.allowPrivateHosts,
          metadata: args.metadata,
        });
        return result.source;
      },
      ingestArtifact: async (
        args: {
          artifactId?: string;
          path?: string;
          uri?: string;
          title?: string;
          tags?: string[];
          folderPath?: string;
          sessionId?: string;
          sourceType?: string;
          connectorId?: string;
          allowPrivateHosts?: boolean;
          metadata?: Record<string, unknown>;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestArtifact({
          artifactId: args.artifactId,
          path: args.path,
          uri: args.uri,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestArtifact']>[0]['sourceType'],
          connectorId: args.connectorId,
          allowPrivateHosts: args.allowPrivateHosts,
          metadata: args.metadata,
        });
        return result.source;
      },
      importBookmarks: async (args: { path: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.importBookmarksFromFile(args);
      },
      importUrls: async (args: { path: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.importUrlsFromFile(args);
      },
      ingestConnector: async (
        args: { connectorId: string; input?: unknown; content?: string; path?: string; sessionId?: string; allowPrivateHosts?: boolean },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return this.service.ingestConnectorInput(args);
      },
      lint: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.lint();
      },
      reindex: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.reindex();
      },
      runJob: async (args: { id: string; mode?: string; sourceIds?: string[]; limit?: number }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return mapJobRun(await this.service.runJob(args.id, {
          ...(args.mode ? { mode: toJobMode(args.mode) } : {}),
          ...(args.sourceIds ? { sourceIds: args.sourceIds } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        }));
      },
      decideCandidate: async (args: { id: string; decision: 'accept' | 'reject' | 'supersede'; decidedBy?: string; memoryClass?: string; scope?: string; detail?: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.decideConsolidationCandidate(args.id, args.decision, {
          decidedBy: args.decidedBy,
          memoryClass: args.memoryClass,
          scope: args.scope,
          detail: args.detail,
        });
      },
      saveSchedule: async (args: { id?: string; jobId: string; label?: string; enabled?: boolean; schedule: Record<string, unknown> }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.saveSchedule({
          id: args.id,
          jobId: args.jobId,
          label: args.label,
          enabled: args.enabled,
          schedule: args.schedule as unknown as Parameters<KnowledgeService['saveSchedule']>[0]['schedule'],
        });
      },
      deleteSchedule: async (args: { id: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.deleteSchedule(args.id);
      },
      setScheduleEnabled: async (args: { id: string; enabled: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.setScheduleEnabled(args.id, args.enabled);
      },
      materializeProjection: async (args: { kind: string; id?: string; limit?: number; filename?: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        const materialized = await this.service.materializeProjection({
          kind: toProjectionKind(args.kind),
          id: args.id,
          limit: clampInt(args.limit, 12),
          filename: args.filename,
        });
        return {
          ...materialized,
          bundle: mapProjectionBundle(materialized.bundle),
        };
      },
    };
  }
}
