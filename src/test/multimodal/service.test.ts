import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { KnowledgeService, KnowledgeStore } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';

describe('MultimodalService', () => {
  let root: string;
  let artifactStore: ArtifactStore;
  let knowledgeStore: KnowledgeStore;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let knowledgeService: KnowledgeService;
  let configManager: ConfigManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gv-multimodal-'));
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    knowledgeStore = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
    await memoryStore.init();
    knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });
    await knowledgeStore.init();
  });

  test('analyzes document artifacts through the built-in extractor path and writes them back into knowledge', async () => {
    const markdownPath = join(root, 'notes.md');
    writeFileSync(markdownPath, '# GoodVibes Memory\n\nStructured knowledge and durable memory live together.\n');
    const artifact = await artifactStore.create({ path: markdownPath });

    const service = new MultimodalService(
      artifactStore,
      { status: async () => [], findProvider: () => null } as never,
      { getStatus: async () => ({ enabled: true, providerCount: 0, providers: [], note: '' }) } as never,
      knowledgeService,
    );

    const analysis = await service.analyze({ artifactId: artifact.id });
    expect(analysis.kind).toBe('document');
    expect(analysis.providerIds).toEqual(['knowledge-extractors']);
    expect(analysis.summary?.toLowerCase()).toContain('structured knowledge');

    const packet = service.buildPacket(analysis);
    expect(packet.rendered).toContain('Multimodal Analysis');
    expect(packet.rendered).toContain('document');

    const writeback = await service.writeBackAnalysis(analysis, {
      sessionId: 'session-mm-doc',
      tags: ['docs', 'memory'],
    });
    expect(writeback.analysisArtifact.id).toBeTruthy();
    expect(writeback.knowledgeSourceId).toBeTruthy();
    expect(knowledgeService.listSources(20).some((source) => source.id === writeback.knowledgeSourceId)).toBe(true);
  });

  test('analyzes audio artifacts through the STT provider contract', async () => {
    const artifact = await artifactStore.create({
      mimeType: 'audio/wav',
      filename: 'meeting.wav',
      dataBase64: Buffer.from('RIFFfakeaudio').toString('base64'),
    });

    const service = new MultimodalService(
      artifactStore,
      { status: async () => [], findProvider: () => null } as never,
      {
        getStatus: async () => ({ enabled: true, providerCount: 1, providers: [], note: '' }),
        transcribe: async () => ({
          providerId: 'openai',
          text: 'Review the memory and knowledge rollout this afternoon.',
          language: 'en',
          segments: [
            { text: 'Review the memory rollout.', startMs: 0, endMs: 1200, confidence: 0.93 },
            { text: 'Then finalize the knowledge work.', startMs: 1200, endMs: 2800, confidence: 0.9 },
          ],
          metadata: {},
        }),
      } as never,
      knowledgeService,
    );

    const analysis = await service.analyze({ artifactId: artifact.id, audioProviderId: 'openai' });
    expect(analysis.kind).toBe('audio');
    expect(analysis.providerIds).toEqual(['openai']);
    expect(analysis.segments.length).toBe(2);
    expect(analysis.text).toContain('knowledge rollout');
  });

  test('analyzes image and video artifacts through media understanding and keyframe fusion', async () => {
    const imageArtifact = await artifactStore.create({
      mimeType: 'image/png',
      filename: 'screen.png',
      dataBase64: Buffer.from('fakepng').toString('base64'),
    });
    const frameArtifact = await artifactStore.create({
      mimeType: 'image/png',
      filename: 'frame-1.png',
      dataBase64: Buffer.from('fakeframe').toString('base64'),
    });
    const audioArtifact = await artifactStore.create({
      mimeType: 'audio/wav',
      filename: 'clip.wav',
      dataBase64: Buffer.from('fakeaudio').toString('base64'),
    });
    const videoArtifact = await artifactStore.create({
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
      dataBase64: Buffer.from('fakevideo').toString('base64'),
      metadata: {
        keyframeArtifactIds: [frameArtifact.id],
        audioArtifactId: audioArtifact.id,
      },
    });

    const service = new MultimodalService(
      artifactStore,
      {
        status: async () => [{ id: 'builtin:image', label: 'Image', state: 'healthy', capabilities: ['understand'], configured: true, metadata: {} }],
        findProvider: () => ({
          analyze: async () => ({
            providerId: 'builtin:image',
            description: 'A UI screenshot showing a memory dashboard.',
            text: 'Memory Dashboard',
            labels: ['dashboard', 'memory'],
            metadata: {},
          }),
        }),
      } as never,
      {
        getStatus: async () => ({ enabled: true, providerCount: 1, providers: [], note: '' }),
        transcribe: async () => ({
          providerId: 'deepgram',
          text: 'The operator is reviewing multimodal memory results.',
          language: 'en',
          segments: [{ text: 'The operator is reviewing multimodal memory results.', startMs: 0, endMs: 1800, confidence: 0.95 }],
          metadata: {},
        }),
      } as never,
      knowledgeService,
    );

    const image = await service.analyze({ artifactId: imageArtifact.id, imageProviderId: 'builtin:image' });
    expect(image.kind).toBe('image');
    expect(image.labels).toContain('dashboard');

    const video = await service.analyze({ artifactId: videoArtifact.id, imageProviderId: 'builtin:image', audioProviderId: 'deepgram' });
    expect(video.kind).toBe('video');
    expect(video.segments.some((segment) => segment.kind === 'scene')).toBe(true);
    expect(video.segments.some((segment) => segment.kind === 'transcript')).toBe(true);
    expect(video.providerIds).toContain('builtin:image');
    expect(video.providerIds).toContain('deepgram');
  });
});
