import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { KnowledgeGraphqlService, KnowledgeService, KnowledgeStore, inspectKnowledgeGraphqlAccess } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/graphql-page') {
        return new Response(
          '<html><head><title>GraphQL Source</title></head><body><h1>GraphQL Source</h1><p>Knowledge GraphQL route coverage.</p></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      return new Response('missing', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe('KnowledgeGraphqlService', () => {
  let root: string;
  let artifactStore: ArtifactStore;
  let knowledgeStore: KnowledgeStore;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let service: KnowledgeService;
  let graphqlService: KnowledgeGraphqlService;
  let configManager: ConfigManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gv-knowledge-graphql-'));
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    configManager.set('network.remoteFetch.allowPrivateHosts', true);
    artifactStore = new ArtifactStore({
      rootDir: join(root, 'artifacts'),
      configManager,
    });
    knowledgeStore = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
    await memoryStore.init();
    service = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });
    graphqlService = new KnowledgeGraphqlService(service);
    await knowledgeStore.init();
  });

  test('supports query operations over the structured knowledge domain', async () => {
    const ingested = await service.ingestUrl({
      url: `${baseUrl}/graphql-page`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      tags: ['graphql'],
      allowPrivateHosts: true,
    });

    const result = await graphqlService.execute({
      query: `
        query KnowledgeGraph($sourceId: String!) {
          status { sourceCount nodeCount note }
          connectors { id sourceType }
          projectionTargets(limit: 4) { targetId kind }
          projection(kind: SOURCE, id: $sourceId) {
            pageCount
            target { targetId kind }
            pages { path content }
          }
        }
      `,
      variables: { sourceId: ingested.source.id },
      admin: false,
      scopes: ['read:knowledge'],
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as {
      status: { sourceCount: number };
      connectors: Array<{ id: string }>;
      projectionTargets: Array<{ kind: string }>;
      projection: { target: { kind: string }; pageCount: number; pages: Array<{ content: string }> };
    };
    expect(data.status.sourceCount).toBeGreaterThan(0);
    expect(data.connectors.some((connector) => connector.id === 'bookmark')).toBe(true);
    expect(data.projectionTargets.some((target) => target.kind === 'OVERVIEW')).toBe(true);
    expect(data.projection.target.kind).toBe('SOURCE');
    expect(data.projection.pageCount).toBe(1);
    expect(data.projection.pages[0]?.content).toContain('GraphQL Source');
  });

  test('supports write mutations with admin posture and reports access requirements', async () => {
    const ingested = await service.ingestUrl({
      url: `${baseUrl}/graphql-page`,
      sourceType: 'url',
      connectorId: 'url',
      allowPrivateHosts: true,
    });

    expect(inspectKnowledgeGraphqlAccess('{ status { sourceCount } }')).toEqual({
      operation: 'query',
      requiredScopes: ['read:knowledge'],
      adminRequired: false,
    });
    expect(inspectKnowledgeGraphqlAccess('mutation { lint { id } }')).toEqual({
      operation: 'mutation',
      requiredScopes: ['write:knowledge'],
      adminRequired: true,
    });

    const result = await graphqlService.execute({
      query: `
        mutation Materialize($sourceId: String!) {
          materializeProjection(kind: SOURCE, id: $sourceId) {
            artifact { id mimeType filename }
            bundle { target { kind } }
          }
        }
      `,
      variables: { sourceId: ingested.source.id },
      admin: true,
      scopes: ['read:knowledge', 'write:knowledge'],
    });

    expect(result.errors).toBeUndefined();
    const data = result.data as {
      materializeProjection: {
        artifact: { id: string; mimeType: string; filename: string };
        bundle: { target: { kind: string } };
      };
    };
    expect(data.materializeProjection.artifact.id).toBeTruthy();
    expect(data.materializeProjection.artifact.mimeType).toBe('text/markdown');
    expect(data.materializeProjection.bundle.target.kind).toBe('SOURCE');
    expect(artifactStore.get(data.materializeProjection.artifact.id)?.id).toBe(data.materializeProjection.artifact.id);
  });

  test('exposes extractions, connector doctor data, and job execution through GraphQL', async () => {
    const csvPath = join(root, 'projects.csv');
    writeFileSync(csvPath, 'project,owner\nGoodVibes,buzzkill\n');

    const ingestArtifact = await graphqlService.execute({
      query: `
        mutation IngestArtifact($path: String!) {
          ingestArtifact(path: $path, connectorId: "artifact") {
            id
            sourceType
          }
        }
      `,
      variables: { path: csvPath },
      admin: true,
      scopes: ['read:knowledge', 'write:knowledge'],
    });
    expect(ingestArtifact.errors).toBeUndefined();

    const sourceId = (ingestArtifact.data as { ingestArtifact: { id: string } }).ingestArtifact.id;
    const query = await graphqlService.execute({
      query: `
        query KnowledgeDepth($sourceId: String!) {
          sourceExtraction(sourceId: $sourceId) { format sections }
          connectorDoctor(id: "bookmark") { ready summary }
          jobs { id defaultMode }
        }
      `,
      variables: { sourceId },
      admin: false,
      scopes: ['read:knowledge'],
    });
    expect(query.errors).toBeUndefined();
    const data = query.data as {
      sourceExtraction: { format: string; sections: string[] };
      connectorDoctor: { ready: boolean; summary: string };
      jobs: Array<{ id: string; defaultMode: string }>;
    };
    expect(data.sourceExtraction.format).toBe('csv');
    expect(data.sourceExtraction.sections).toContain('project');
    expect(data.connectorDoctor.ready).toBe(true);
    expect(data.jobs.some((job) => job.id === 'knowledge-lint')).toBe(true);

    const runJob = await graphqlService.execute({
      query: `
        mutation RunJob {
          runJob(id: "knowledge-lint", mode: INLINE) {
            id
            status
            mode
          }
        }
      `,
      admin: true,
      scopes: ['read:knowledge', 'write:knowledge'],
    });
    expect(runJob.errors).toBeUndefined();
    const runData = runJob.data as { runJob: { status: string; mode: string } };
    expect(runData.runJob.status).toBe('completed');
    expect(runData.runJob.mode).toBe('INLINE');
  });

  test('exposes consolidation queues and managed schedules through GraphQL', async () => {
    const ingested = await service.ingestUrl({
      url: `${baseUrl}/graphql-page`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      tags: ['project:goodvibes-tui', 'capability:knowledge'],
      allowPrivateHosts: true,
    });
    await service.recordUsage({ targetKind: 'source', targetId: ingested.source.id, usageKind: 'search-hit', score: 95, sessionId: 's1' });
    await service.recordUsage({ targetKind: 'source', targetId: ingested.source.id, usageKind: 'packet-item', score: 92, sessionId: 's2' });
    await service.recordUsage({ targetKind: 'source', targetId: ingested.source.id, usageKind: 'item-open', score: 90, sessionId: 's3' });
    await service.recordUsage({ targetKind: 'source', targetId: ingested.source.id, usageKind: 'neighbor-open', score: 88, sessionId: 's4' });
    await service.recordUsage({ targetKind: 'source', targetId: ingested.source.id, usageKind: 'projection-read', score: 86, sessionId: 's5' });
    await service.runJob('knowledge-light-consolidation', { mode: 'inline' });

    const query = await graphqlService.execute({
      query: `
        query Consolidation {
          usage(limit: 5) { targetKind usageKind }
          consolidationCandidates(limit: 10) { candidateType status title }
          consolidationReports(limit: 10) { kind title }
          schedules(limit: 10) { jobId enabled }
        }
      `,
      admin: false,
      scopes: ['read:knowledge'],
    });

    expect(query.errors).toBeUndefined();
    const data = query.data as {
      usage: Array<{ usageKind: string }>;
      consolidationCandidates: Array<{ candidateType: string; status: string }>;
      consolidationReports: Array<{ kind: string }>;
      schedules: Array<{ jobId: string; enabled: boolean }>;
    };
    expect(data.usage.length).toBeGreaterThan(0);
    expect(data.consolidationCandidates.some((candidate) => candidate.candidateType === 'memory-promotion')).toBe(true);
    expect(data.consolidationReports.some((report) => report.kind === 'light-consolidation')).toBe(true);
    expect(data.schedules.some((schedule) => schedule.jobId === 'knowledge-light-consolidation')).toBe(true);
  });
});
