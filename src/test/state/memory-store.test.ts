/**
 * Tests for MemoryStore — CRUD, search, links, delete cascade.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryStore, MemoryRegistry } from '../../state/memory-store.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';

function tempDbPath(): string {
  return join(tmpdir(), `memory-test-${randomUUID()}.db`);
}

describe('MemoryStore', () => {
  let store: MemoryStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = new MemoryStore(dbPath);
    await store.init();
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('add', () => {
    it('creates a record with correct fields', async () => {
      const rec = await store.add({
        cls: 'decision',
        summary: 'Use SQLite for storage',
        tags: ['db', 'arch'],
      });

      expect(rec.id).toMatch(/^mem_/);
      expect(rec.cls).toBe('decision');
      expect(rec.summary).toBe('Use SQLite for storage');
      expect(rec.tags).toEqual(['db', 'arch']);
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
      await store.add({ cls: 'decision', summary: 'Use Bun runtime', tags: ['runtime'] });
      await store.add({ cls: 'constraint', summary: 'No eval in production', tags: ['security'] });
      await store.add({ cls: 'incident', summary: 'Memory leak in parser', tags: ['runtime', 'bug'] });
      await store.add({ cls: 'pattern', summary: 'Retry with backoff', tags: ['resilience'] });
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

    it('persists the update (round-trips through get)', async () => {
      const rec = await store.add({ cls: 'pattern', summary: 'Before' });
      store.update(rec.id, { summary: 'After' });
      const fetched = store.get(rec.id);
      expect(fetched!.summary).toBe('After');
    });

    it('returns null for unknown ID', () => {
      expect(store.update('bogus', { summary: 'x' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the record', async () => {
      const rec = await store.add({ cls: 'incident', summary: 'Crash on startup' });
      const removed = store.delete(rec.id);
      expect(removed).toBe(true);
      expect(store.get(rec.id)).toBeNull();
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

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = new MemoryStore(dbPath);
    await store.init();
    registry = new MemoryRegistry(store);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
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
