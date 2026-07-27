import { beforeEach, describe, expect, test } from 'bun:test';
import { createKnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import { resetTestRuntimeServices, getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

describe('KnowledgeApi', () => {
  beforeEach(() => {
    resetTestRuntimeServices();
  });

  test('groups status, connector, and query surfaces over the knowledge runtime', async () => {
    const runtimeServices = getTestRuntimeServices();
    const api = createKnowledgeApi(runtimeServices.knowledgeService, {
      memoryRegistry: runtimeServices.memoryRegistry,
    });

    const status = await api.status.get();
    expect(status).toMatchObject({
      ready: expect.any(Boolean),
      note: expect.stringContaining('Structured knowledge'),
    });

    const connectors = api.connectors.list();
    expect(connectors.length).toBeGreaterThan(0);
    expect(api.connectors.get(connectors[0]!.id)?.id).toBe(connectors[0]!.id);

    const sourceQuery = api.sources.query({ limit: 5 });
    expect(sourceQuery).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
    expect(api.graph.nodes.query({ limit: 5 })).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });

    await runtimeServices.memoryRegistry.getStore().init();
    await runtimeServices.memoryRegistry.add({
      cls: 'runbook',
      summary: 'Keep knowledge intent semantics explicit for foundation consumers.',
      tags: ['knowledge', 'foundation'],
      provenance: [{ kind: 'file', ref: 'src/knowledge/knowledge-api.ts' }],
      review: { state: 'reviewed', confidence: 93 },
    });
    const explain = api.memory?.explain('update knowledge api', ['src/knowledge']);
    expect(explain?.injections[0]).toMatchObject({
      trustTier: 'reviewed',
      useAs: 'reference-material',
      retention: 'task-only',
      provenance: {
        source: 'project-memory',
        links: [{ kind: 'file', ref: 'src/knowledge/knowledge-api.ts' }],
      },
    });
    expect(explain?.prompt).toContain('Explicit semantics');
  });

  test('surfaces ingest, packets, projections, jobs, and consolidation through grouped domains', async () => {
    const runtimeServices = getTestRuntimeServices();
    const api = createKnowledgeApi(runtimeServices.knowledgeService);
    const artifact = await runtimeServices.artifactStore.create({
      filename: 'knowledge-api.txt',
      text: 'GoodVibes knowledge api artifact body',
    });

    const ingest = await api.ingest.artifact({
      artifactId: artifact.id,
      title: 'Knowledge API Artifact',
      tags: ['sdk-ready'],
      fetchMode: 'public-only',
    });
    expect(ingest.source.id).toBeTruthy();
    expect(ingest.source.metadata).toMatchObject({
      knowledgeIntent: {
        ingestMode: 'artifact',
        remoteFetchMode: 'public-only',
      },
    });

    const packet = await api.packets.build('knowledge api artifact', [], 5, { budgetLimit: 2_000 });
    expect(packet.items.length).toBeGreaterThan(0);

    const targets = await api.projections.listTargets(10);
    expect(targets.length).toBeGreaterThan(0);

    const jobs = api.jobs.list();
    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0]!;
    expect(api.jobs.get(job.id)?.id).toBe(job.id);

    const run = await api.jobs.run(job.id, { mode: 'inline' });
    expect(run.jobId).toBe(job.id);
    expect(api.jobs.runs(10, job.id).some((entry) => entry.id === run.id)).toBe(true);

    const candidates = api.consolidation.candidates(10);
    expect(Array.isArray(candidates)).toBe(true);
    expect(Array.isArray(api.consolidation.reports(10))).toBe(true);
  });
});
