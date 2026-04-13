import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';
import { ConfigManager } from '../../config/manager.ts';
import { KnowledgeService, KnowledgeStore } from '../../knowledge/index.ts';
import { MemoryRegistry, MemoryStore } from '../../state/index.ts';
import { MemoryEmbeddingProviderRegistry } from '../../state/index.ts';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        '<html><head><title>Projection Source</title></head><body><h1>Projection</h1><p>Structured knowledge projection test page.</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

describe('Knowledge projections', () => {
  let root: string;
  let artifactStore: ArtifactStore;
  let knowledgeStore: KnowledgeStore;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let service: KnowledgeService;
  let configManager: ConfigManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gv-knowledge-projection-'));
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

  test('lists renderable targets and renders markdown bundle projections', async () => {
    const ingested = await service.ingestUrl({
      url: `${baseUrl}/projection`,
      sourceType: 'bookmark',
      connectorId: 'bookmark',
      folderPath: 'Research/Projection',
      tags: ['projection', 'knowledge'],
      allowPrivateHosts: true,
    });

    const targets = await service.listProjectionTargets(8);
    expect(targets.some((target) => target.kind === 'overview')).toBe(true);
    expect(targets.some((target) => target.kind === 'bundle')).toBe(true);
    expect(targets.some((target) => target.kind === 'source' && target.itemId === ingested.source.id)).toBe(true);
    expect(targets.some((target) => target.kind === 'dashboard')).toBe(true);

    const bundle = await service.renderProjection({ kind: 'bundle', limit: 4 });
    expect(bundle.pageCount).toBeGreaterThan(1);
    expect(bundle.pages[0]?.content).toContain('Structured knowledge is canonical in SQL');
    expect(bundle.pages.some((page) => page.content.includes('Projection Source'))).toBe(true);
    expect(bundle.pages.some((page) => page.title.includes('Source Health'))).toBe(true);
  });

  test('materializes a single-item markdown projection as an artifact', async () => {
    const ingested = await service.ingestUrl({
      url: `${baseUrl}/projection`,
      sourceType: 'url',
      connectorId: 'url',
      allowPrivateHosts: true,
    });

    const materialized = await service.materializeProjection({
      kind: 'source',
      id: ingested.source.id,
    });

    expect(materialized.bundle.pageCount).toBe(1);
    expect(materialized.bundle.pages[0]?.content).toContain('Projection Source');
    expect(materialized.artifact.mimeType).toBe('text/markdown');
    expect(materialized.artifact.filename).toContain('.md');
    const artifact = artifactStore.get(materialized.artifact.id);
    expect(artifact?.id).toBe(materialized.artifact.id);
  });
});
