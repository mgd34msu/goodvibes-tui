import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';
import { ConfigManager } from '../../config/manager.ts';
import { KnowledgeService, KnowledgeStore } from '../../knowledge/index.ts';
import { RuntimeEventBus } from '../../runtime/events/index.ts';
import { MemoryRegistry, MemoryStore } from '../../state/index.ts';
import { MemoryEmbeddingProviderRegistry } from '../../state/index.ts';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/docs/typescript') {
        return new Response(
          '<html><head><title>TypeScript Docs</title></head><body><h1>TypeScript</h1><p>Official language documentation.</p><a href="https://example.com/more">More</a></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }
      if (url.pathname === '/docs/bun') {
        return new Response(
          '<html><head><title>Bun Runtime</title></head><body><h1>Bun</h1><p>Fast all-in-one JavaScript runtime.</p></body></html>',
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

describe('KnowledgeService', () => {
  let root: string;
  let artifactStore: ArtifactStore;
  let knowledgeStore: KnowledgeStore;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let service: KnowledgeService;
  let configManager: ConfigManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gv-knowledge-'));
    configManager = new ConfigManager({ configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
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
    await knowledgeStore.init();
  });

  test('ingests a URL, snapshots it as an artifact, and compiles related nodes', async () => {
    const result = await service.ingestUrl({
      url: `${baseUrl}/docs/typescript`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      folderPath: 'Programming / TypeScript',
      tags: ['typescript', 'docs'],
      sessionId: 'session-1',
      allowPrivateHosts: true,
    });

    expect(result.source.status).toBe('indexed');
    expect(result.source.title).toBe('TypeScript Docs');
    expect(result.source.summary).toContain('Official language documentation');
    expect(result.artifactId).toBeTruthy();

    const artifact = artifactStore.get(result.artifactId!);
    expect(artifact?.sourceUri).toBe(`${baseUrl}/docs/typescript`);
    expect(artifact).toMatchObject({
      acquisitionMode: 'remote-fetch',
      fetchMode: 'allow-private-hosts',
    });

    const nodes = service.listNodes(20);
    expect(nodes.some((node) => node.kind === 'domain' && node.title === '127.0.0.1')).toBe(true);
    expect(nodes.some((node) => node.kind === 'bookmark_folder' && node.title === 'TypeScript')).toBe(true);
    expect(nodes.some((node) => node.kind === 'topic' && node.title === 'typescript')).toBe(true);

    const packet = await service.buildPacket('typescript docs', ['Programming']);
    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.items[0]?.title.toLowerCase()).toContain('typescript');
  });

  test('imports bookmarks from a Netscape-style bookmark file', async () => {
    const bookmarksPath = join(root, 'bookmarks.html');
    writeFileSync(bookmarksPath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><H3>Reading</H3>
  <DL><p>
    <DT><A HREF="${baseUrl}/docs/typescript">TypeScript Docs</A>
    <DT><A HREF="${baseUrl}/docs/bun">Bun Runtime</A>
  </DL><p>
</DL><p>`);

    const result = await service.importBookmarksFromFile({
      path: bookmarksPath,
      sessionId: 'session-2',
      allowPrivateHosts: true,
    });
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);
    expect(service.listSources(10).some((source) => source.folderPath === 'Reading')).toBe(true);
  });

  test('mirrors reviewed memory into the knowledge graph during reindex', async () => {
    await memoryRegistry.add({
      cls: 'decision',
      summary: 'Use sqlite-vec for semantic recall',
      detail: 'Project memory uses sqlite-vec as the default vector store.',
      tags: ['sqlite-vec', 'memory'],
      provenance: [{ kind: 'session', ref: 'session-99' }],
      review: { state: 'reviewed', confidence: 92 },
    });

    const result = await service.reindex();
    expect(result.status.nodeCount).toBeGreaterThan(0);
    const memoryNode = service.listNodes(100).find((node) => node.kind === 'memory');
    expect(memoryNode?.title).toContain('sqlite-vec');
  });

  test('supports future ingest ideas through connector registration', async () => {
    service.registerConnector({
      id: 'bookmark-jsonl',
      description: 'JSONL bookmark connector for future sources.',
      sourceType: 'bookmark',
      resolve(input) {
        const records = String(input)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { url: string; title?: string; folder?: string });
        return {
          seeds: records.map((record) => ({
            url: record.url,
            title: record.title,
            folderPath: record.folder,
          })),
        };
      },
    });

    const result = await service.ingestWithConnector(
      'bookmark-jsonl',
      `{"url":"${baseUrl}/docs/bun","title":"Saved Bun","folder":"Research"}`,
      'session-3',
      true,
    );
    expect(result.imported).toBe(1);
    expect(service.listSources(10).some((source) => source.connectorId === 'bookmark-jsonl')).toBe(true);
  });

  test('ingests local artifacts with structured extraction and emits knowledge events', async () => {
    const csvPath = join(root, 'research.csv');
    writeFileSync(csvPath, 'project,owner\nGoodVibes,buzzkill\nOpenClaw,community\n');

    const runtimeBus = new RuntimeEventBus();
    const events: string[] = [];
    runtimeBus.onDomain('knowledge', ({ payload }) => events.push(payload.type));
    service = new KnowledgeService(knowledgeStore, artifactStore, undefined, { runtimeBus, memoryRegistry });

    const result = await service.ingestArtifact({
      path: csvPath,
      connectorId: 'artifact',
      tags: ['research', 'csv'],
      sessionId: 'session-artifact',
    });

    expect(result.source.status).toBe('indexed');
    expect(result.source.sourceType).toBe('dataset');
    expect(result.extraction?.format).toBe('csv');
    expect(service.getSourceExtraction(result.source.id)?.sections).toContain('project');
    expect(artifactStore.get(result.artifactId!)).toMatchObject({
      acquisitionMode: 'local-path',
      fetchMode: 'not-applicable',
    });
    expect(events).toContain('KNOWLEDGE_INGEST_STARTED');
    expect(events).toContain('KNOWLEDGE_EXTRACTION_COMPLETED');
    expect(events).toContain('KNOWLEDGE_INGEST_COMPLETED');
  });

  test('runs built-in knowledge jobs and records run history', async () => {
    await service.ingestUrl({
      url: `${baseUrl}/docs/typescript`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      allowPrivateHosts: true,
    });

    const run = await service.runJob('knowledge-lint', { mode: 'inline' });
    expect(run.status).toBe('completed');
    expect(service.listJobs().some((job) => job.id === 'knowledge-lint')).toBe(true);
    expect(service.listJobRuns(10).some((entry) => entry.id === run.id && entry.jobId === 'knowledge-lint')).toBe(true);
  });

  test('tracks usage, compiles canonical entity nodes, and runs consolidation jobs with managed schedules', async () => {
    const result = await service.ingestUrl({
      url: `${baseUrl}/docs/typescript`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      folderPath: 'Projects / GoodVibes',
      tags: ['project:goodvibes-tui', 'capability:memory', 'provider:openai'],
      allowPrivateHosts: true,
      metadata: {
        repo: 'goodvibes-tui',
        service: 'typescript-docs',
        environment: 'local-dev',
      },
    });

    for (let index = 0; index < 3; index += 1) {
      await service.recordUsage({
        targetKind: 'source',
        targetId: result.source.id,
        usageKind: 'search-hit',
        task: `lookup-${index}`,
        sessionId: `session-${index}`,
        score: 96,
      });
    }
    await service.recordUsage({ targetKind: 'source', targetId: result.source.id, usageKind: 'packet-item', score: 92 });
    await service.recordUsage({ targetKind: 'source', targetId: result.source.id, usageKind: 'item-open', score: 88 });
    await service.recordUsage({ targetKind: 'source', targetId: result.source.id, usageKind: 'neighbor-open', score: 84 });
    await service.recordUsage({ targetKind: 'source', targetId: result.source.id, usageKind: 'projection-read', score: 80 });

    const nodes = service.listNodes(200);
    expect(nodes.some((node) => node.kind === 'project' && node.title === 'goodvibes-tui')).toBe(true);
    expect(nodes.some((node) => node.kind === 'capability' && node.title === 'memory')).toBe(true);
    expect(nodes.some((node) => node.kind === 'repo' && node.title === 'goodvibes-tui')).toBe(true);
    expect(nodes.some((node) => node.kind === 'service' && node.title === 'typescript-docs')).toBe(true);
    expect(nodes.some((node) => node.kind === 'environment' && node.title === 'local-dev')).toBe(true);

    const light = await service.runJob('knowledge-light-consolidation', { mode: 'inline' });
    expect(light.status).toBe('completed');
    expect(service.listConsolidationCandidates(20).some((candidate) => candidate.candidateType === 'memory-promotion')).toBe(true);
    expect(service.listConsolidationReports(10).some((report) => report.kind === 'light-consolidation')).toBe(true);

    const deep = await service.runJob('knowledge-deep-consolidation', { mode: 'inline' });
    expect(deep.status).toBe('completed');
    expect(memoryRegistry.getAll().some((record) => record.summary.toLowerCase().includes('typescript'))).toBe(true);

    const schedules = service.listSchedules(10);
    expect(schedules.some((schedule) => schedule.jobId === 'knowledge-light-consolidation')).toBe(true);
    expect(schedules.some((schedule) => schedule.jobId === 'knowledge-deep-consolidation')).toBe(true);
  });
});
