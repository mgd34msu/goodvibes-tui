/**
 * Tests for MemoryStore — CRUD, search, links, delete cascade.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryStore, MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import { resolveMemoryVectorDbPath } from '@pellux/goodvibes-sdk/platform/state/memory-vector-store';
import { DEFAULT_MEMORY_EMBEDDING_DIMS, MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/index';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

function tempDbPath(): string {
  return join(tmpdir(), `memory-test-${randomUUID()}.db`);
}

function cleanupDbPair(dbPath: string): void {
  if (existsSync(dbPath)) unlinkSync(dbPath);
  const vectorPath = resolveMemoryVectorDbPath(dbPath);
  if (existsSync(vectorPath)) unlinkSync(vectorPath);
}

describe('MemoryStore', () => {
  let store: MemoryStore;
  let dbPath: string;
  let configRoot: string;
  let configDir: string;
  let configManager: ConfigManager;
  let embeddingRegistry: MemoryEmbeddingProviderRegistry;

  beforeEach(async () => {
    dbPath = tempDbPath();
    configRoot = mkdtempSync(join(tmpdir(), 'memory-config-'));
    configDir = join(configRoot, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: configRoot });
    embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    store = new MemoryStore(dbPath, { embeddingRegistry });
    await store.init();
  });

  afterEach(() => {
    store.close();
    cleanupDbPair(dbPath);
    rmSync(configRoot, { recursive: true, force: true });
    resetTestRuntimeServices();
  });

  describe('add', () => {
    it('creates a record with correct fields', async () => {
      const rec = await store.add({
        cls: 'fact',
        summary: 'Use SQLite for storage',
        tags: ['db', 'arch'],
      });

      expect(rec.id).toMatch(/^mem_/);
      expect(rec.cls).toBe('fact');
      expect(rec.summary).toBe('Use SQLite for storage');
      expect(rec.tags).toEqual(['db', 'arch']);
      expect(rec.reviewState).toBe('fresh');
      expect(rec.confidence).toBeGreaterThan(0);
      expect(rec.createdAt).toBeGreaterThan(0);
      expect(rec.updatedAt).toBe(rec.createdAt);
    });

    it('generates unique IDs for each record', async () => {
      const a = await store.add({ cls: 'pattern', summary: 'A' });
      const b = await store.add({ cls: 'pattern', summary: 'B' });
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('get', () => {
    it('retrieves an existing record by ID', async () => {
      const rec = await store.add({ cls: 'constraint', summary: 'No globals' });
      const found = store.get(rec.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(rec.id);
      expect(found!.summary).toBe('No globals');
    });

    it('returns null for unknown ID', () => {
      expect(store.get('nonexistent')).toBeNull();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await store.add({ cls: 'decision', summary: 'Use Bun runtime', tags: ['runtime'], review: { state: 'reviewed', confidence: 90 } });
      await store.add({ cls: 'constraint', summary: 'No eval in production', tags: ['security'], review: { state: 'fresh', confidence: 75 } });
      await store.add({ cls: 'incident', summary: 'Memory leak in parser', tags: ['runtime', 'bug'], review: { state: 'stale', confidence: 40, staleReason: 'parser architecture changed' } });
      await store.add({ cls: 'pattern', summary: 'Retry with backoff', tags: ['resilience'], review: { state: 'fresh', confidence: 65 } });
    });

    it('returns all records with no filter', () => {
      const results = store.search({});
      expect(results.length).toBe(4);
    });

    it('filters by class', () => {
      const results = store.search({ cls: 'decision' });
      expect(results.length).toBe(1);
      expect(results[0].cls).toBe('decision');
    });

    it('filters by scope', async () => {
      await store.add({ scope: 'team', cls: 'runbook', summary: 'Team deploy checklist' });
      const results = store.search({ scope: 'team' });
      expect(results.length).toBe(1);
      expect(results[0].scope).toBe('team');
    });

    it('filters by query (summary match via SQL LIKE)', () => {
      const results = store.search({ query: 'Bun' });
      expect(results.length).toBe(1);
      expect(results[0].summary).toContain('Bun');
    });

    it('applies limit correctly after all filters', () => {
      const results = store.search({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('does not over-limit when filtering', () => {
      // Only 1 incident; limit=10 should return exactly 1
      const results = store.search({ cls: 'incident', limit: 10 });
      expect(results.length).toBe(1);
    });

    it('filters by since timestamp', async () => {
      const before = Date.now();
      const added = await store.add({ cls: 'pattern', summary: 'New pattern after cutoff' });
      const results = store.search({ since: before });
      expect(results.some((record) => record.id === added.id)).toBe(true);
      expect(results.every((record) => record.createdAt >= before)).toBe(true);
    });

    it('filters by single tag', () => {
      const results = store.search({ tags: ['runtime'] });
      expect(results.length).toBe(2);
      expect(results.every(r => r.tags.includes('runtime'))).toBe(true);
    });

    it('filters by multiple tags (AND semantics)', () => {
      // Only the incident has both 'runtime' and 'bug'
      const results = store.search({ tags: ['runtime', 'bug'] });
      expect(results.length).toBe(1);
      expect(results[0].summary).toContain('Memory leak');
    });

    it('returns no results when tag does not match any record', () => {
      const results = store.search({ tags: ['nonexistent-tag'] });
      expect(results.length).toBe(0);
    });

    it('orders higher confidence reviewed records first for search results', () => {
      const results = store.search({});
      expect(results[0].summary).toContain('Use Bun runtime');
      expect(results[results.length - 1].reviewState).toBe('stale');
    });

    it('uses sqlite-vec for semantic memory search when requested', () => {
      const stats = store.vectorStats();
      expect(stats.backend).toBe('sqlite-vec');
      expect(stats.available).toBe(true);
      expect(stats.indexedRecords).toBeGreaterThanOrEqual(4);

      const results = store.searchSemantic({ query: 'runtime bun execution', limit: 2 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].record.summary).toContain('Use Bun runtime');
      expect(results[0].similarity).toBeGreaterThan(0);
    });

    it('rebuilds vectors asynchronously through a provider-backed embedding path', async () => {
      resetTestRuntimeServices();
      const asyncConfigRoot = mkdtempSync(join(tmpdir(), 'memory-config-'));
      const asyncConfigDir = join(asyncConfigRoot, '.goodvibes', 'tui');
      mkdirSync(asyncConfigDir, { recursive: true });
      const configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: asyncConfigDir, workingDir: asyncConfigRoot });
      const registry = new MemoryEmbeddingProviderRegistry({ configManager });
      let embedCalls = 0;
      registry.register({
        id: 'async-test',
        label: 'Async Test Embeddings',
        dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
        async embed(request) {
          embedCalls += 1;
          return {
            vector: new Float32Array(request.dimensions).fill(1),
            dimensions: request.dimensions,
            modelId: 'async-test-model',
          };
        },
      }, { makeDefault: true });

      const asyncDbPath = tempDbPath();
      const asyncStore = new MemoryStore(asyncDbPath, { embeddingRegistry: registry });
      await asyncStore.init();
      await asyncStore.add({ cls: 'fact', summary: 'Provider-backed rebuild target' });

      try {
        embedCalls = 0;
        const stats = await asyncStore.rebuildVectorIndexAsync();
        expect(embedCalls).toBeGreaterThan(0);
        expect(stats.indexedRecords).toBeGreaterThan(0);
      } finally {
        asyncStore.close();
        cleanupDbPair(asyncDbPath);
        rmSync(asyncConfigRoot, { recursive: true, force: true });
        resetTestRuntimeServices();
      }
    });
  });

  describe('update', () => {
    it('updates summary, detail, and tags', async () => {
      const rec = await store.add({ cls: 'decision', summary: 'Old summary' });
      const updated = store.update(rec.id, { summary: 'New summary', tags: ['a', 'b'] });
      expect(updated).not.toBeNull();
      expect(updated!.summary).toBe('New summary');
      expect(updated!.tags).toEqual(['a', 'b']);
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt);
    });

    it('updates scope for team handoff workflows', async () => {
      const rec = await store.add({ scope: 'session', cls: 'decision', summary: 'Session-only knowledge' });
      const updated = store.update(rec.id, { scope: 'team' });
      expect(updated).not.toBeNull();
      expect(updated!.scope).toBe('team');
      expect(store.get(rec.id)?.scope).toBe('team');
    });

    it('persists the update (round-trips through get)', async () => {
      const rec = await store.add({ cls: 'pattern', summary: 'Before' });
      store.update(rec.id, { summary: 'After' });
      const fetched = store.get(rec.id);
      expect(fetched!.summary).toBe('After');
    });

    it('updates the sqlite-vec index after record edits', async () => {
      const rec = await store.add({ cls: 'pattern', summary: 'Legacy phrasing' });
      store.update(rec.id, { summary: 'Orchestration graph node runtime edits' });

      const results = store.searchSemantic({ query: 'orchestration graph runtime', limit: 1 });
      expect(results[0]?.record.id).toBe(rec.id);
    });

    it('returns null for unknown ID', () => {
      expect(store.update('bogus', { summary: 'x' })).toBeNull();
    });
  });

  describe('review', () => {
    it('updates review state, confidence, and reviewer fields', async () => {
      const rec = await store.add({ cls: 'fact', summary: 'Knowledge record' });
      const reviewed = store.review(rec.id, {
        state: 'reviewed',
        confidence: 88,
        reviewedBy: 'operator',
      });
      expect(reviewed).not.toBeNull();
      expect(reviewed!.reviewState).toBe('reviewed');
      expect(reviewed!.confidence).toBe(88);
      expect(reviewed!.reviewedBy).toBe('operator');
      expect(reviewed!.reviewedAt).toBeGreaterThan(0);
      expect(store.get(rec.id)?.reviewState).toBe('reviewed');
    });

    it('marks stale records with a reason', async () => {
      const rec = await store.add({ cls: 'risk', summary: 'Risky fact' });
      const reviewed = store.review(rec.id, {
        state: 'stale',
        staleReason: 'changed upstream source',
      });
      expect(reviewed).not.toBeNull();
      expect(reviewed!.reviewState).toBe('stale');
      expect(reviewed!.staleReason).toContain('changed upstream source');
    });
  });

  describe('reviewQueue', () => {
    it('prioritizes stale and low-confidence records for operator review', async () => {
      const reviewed = await store.add({ cls: 'decision', summary: 'Reviewed', review: { state: 'reviewed', confidence: 90 } });
      const stale = await store.add({ cls: 'incident', summary: 'Stale', review: { state: 'stale', confidence: 30 } });
      const fresh = await store.add({ cls: 'fact', summary: 'Fresh', review: { state: 'fresh', confidence: 60 } });

      const queue = store.reviewQueue(3);
      expect(queue[0].id).toBe(stale.id);
      expect(queue.some((record) => record.id === reviewed.id)).toBe(true);
      expect(queue.some((record) => record.id === fresh.id)).toBe(true);
    });
  });

  describe('bundle import/export', () => {
    it('exports filtered bundles with records and links', async () => {
      const a = await store.add({ scope: 'team', cls: 'decision', summary: 'Share the deployment path' });
      const b = await store.add({ scope: 'team', cls: 'runbook', summary: 'Deploy checklist' });
      await store.link(a.id, b.id, 'references');

      const bundle = store.exportBundle({ scope: 'team' });
      expect(bundle.scope).toBe('team');
      expect(bundle.recordCount).toBe(2);
      expect(bundle.linkCount).toBe(1);
      expect(bundle.records.every((record) => record.scope === 'team')).toBe(true);
    });

    it('imports bundles while preserving ids and links', async () => {
      const source = await store.add({ scope: 'team', cls: 'decision', summary: 'Source memory' });
      const target = await store.add({ scope: 'team', cls: 'pattern', summary: 'Related pattern' });
      await store.link(source.id, target.id, 'supports');
      const bundle = store.exportBundle({ scope: 'team' });

      const otherPath = tempDbPath();
      const otherConfigRoot = mkdtempSync(join(tmpdir(), 'memory-test-config-'));
      const otherConfigDir = join(otherConfigRoot, '.goodvibes', 'tui');
      mkdirSync(otherConfigDir, { recursive: true });
      const otherConfigManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: otherConfigDir, workingDir: otherConfigRoot });
      const otherStore = new MemoryStore(otherPath, {
        embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: otherConfigManager }),
      });
      await otherStore.init();

      try {
        const result = await otherStore.importBundle(bundle);
        expect(result.importedRecords).toBe(2);
        expect(result.skippedRecords).toBe(0);
        expect(result.importedLinks).toBe(1);
        expect(otherStore.get(source.id)?.scope).toBe('team');
        expect(otherStore.linksFor(source.id)[0]?.relation).toBe('supports');
      } finally {
        otherStore.close();
        cleanupDbPair(otherPath);
        rmSync(otherConfigRoot, { recursive: true, force: true });
      }
    });
  });

  describe('delete', () => {
    it('removes the record', async () => {
      const rec = await store.add({ cls: 'incident', summary: 'Crash on startup' });
      const removed = store.delete(rec.id);
      expect(removed).toBe(true);
      expect(store.get(rec.id)).toBeNull();
      expect(store.searchSemantic({ query: 'Crash on startup', limit: 3 }).some((entry) => entry.record.id === rec.id)).toBe(false);
    });

    it('returns false for unknown ID', () => {
      expect(store.delete('bogus')).toBe(false);
    });

    it('cascades to links (FK ON DELETE CASCADE)', async () => {
      const a = await store.add({ cls: 'decision', summary: 'A' });
      const b = await store.add({ cls: 'pattern', summary: 'B' });
      await store.link(a.id, b.id, 'caused');

      expect(store.linksFor(a.id).length).toBe(1);
      store.delete(a.id);
      // After deletion, links referencing a should be gone
      expect(store.linksFor(b.id).length).toBe(0);
    });
  });

  describe('link / linksFor', () => {
    it('creates a directed link and retrieves it', async () => {
      const a = await store.add({ cls: 'decision', summary: 'A' });
      const b = await store.add({ cls: 'pattern', summary: 'B' });
      const link = await store.link(a.id, b.id, 'supersedes');
      expect(link).not.toBeNull();
      expect(link!.relation).toBe('supersedes');

      const links = store.linksFor(a.id);
      expect(links.length).toBe(1);
      expect(links[0].fromId).toBe(a.id);
      expect(links[0].toId).toBe(b.id);
    });

    it('returns null when source does not exist', async () => {
      const b = await store.add({ cls: 'pattern', summary: 'B' });
      const link = await store.link('bogus', b.id, 'caused');
      expect(link).toBeNull();
    });

    it('returns links from both directions', async () => {
      const a = await store.add({ cls: 'decision', summary: 'A' });
      const b = await store.add({ cls: 'pattern', summary: 'B' });
      await store.link(a.id, b.id, 'caused');

      // linksFor(b) should see the link too
      const links = store.linksFor(b.id);
      expect(links.length).toBe(1);
    });
  });
});

describe('MemoryRegistry', () => {
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let dbPath: string;
  let configRoot: string;
  let configDir: string;
  let configManager: ConfigManager;
  let embeddingRegistry: MemoryEmbeddingProviderRegistry;

  beforeEach(async () => {
    dbPath = tempDbPath();
    configRoot = mkdtempSync(join(tmpdir(), 'memory-registry-config-'));
    configDir = join(configRoot, '.goodvibes', 'tui');
    mkdirSync(configDir, { recursive: true });
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir, workingDir: configRoot });
    embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
    store = new MemoryStore(dbPath, { embeddingRegistry });
    await store.init();
    registry = new MemoryRegistry(store);
  });

  afterEach(() => {
    store.close();
    cleanupDbPair(dbPath);
    rmSync(configRoot, { recursive: true, force: true });
  });

  it('notifies listeners on add', async () => {
    let called = 0;
    registry.subscribe(() => { called++; });
    await registry.add({ cls: 'decision', summary: 'test' });
    expect(called).toBe(1);
  });

  it('notifies listeners on update', async () => {
    const rec = await registry.add({ cls: 'pattern', summary: 'A' });
    let called = 0;
    registry.subscribe(() => { called++; });
    registry.update(rec.id, { summary: 'B' });
    expect(called).toBe(1);
  });

  it('notifies listeners on review', async () => {
    const rec = await registry.add({ cls: 'pattern', summary: 'A' });
    let called = 0;
    registry.subscribe(() => { called++; });
    registry.review(rec.id, { state: 'reviewed', confidence: 95, reviewedBy: 'operator' });
    expect(called).toBe(1);
  });

  it('notifies listeners on delete', async () => {
    const rec = await registry.add({ cls: 'incident', summary: 'oops' });
    let called = 0;
    registry.subscribe(() => { called++; });
    registry.delete(rec.id);
    expect(called).toBe(1);
  });

  it('unsubscribe stops notifications', async () => {
    let called = 0;
    const unsub = registry.subscribe(() => { called++; });
    unsub();
    await registry.add({ cls: 'pattern', summary: 'x' });
    expect(called).toBe(0);
  });
});
