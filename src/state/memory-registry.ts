import type { MemoryAddOptions, MemoryBundle, MemoryDoctorReport, MemoryLink, MemoryRecord, MemoryReviewPatch, MemoryScope, MemorySearchFilter, MemorySemanticSearchResult, MemoryStore } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import type { MemoryVectorStats } from '@pellux/goodvibes-sdk/platform/state/memory-vector-store';
import type { MemoryImportResult } from '@pellux/goodvibes-sdk/platform/state/memory-store';

/**
 * MemoryRegistry — thin observable wrapper around the MemoryStore.
 * Panels subscribe via listeners; commands push/retrieve through this.
 */
export class MemoryRegistry {
  private store: MemoryStore;
  private listeners: Array<() => void> = [];

  constructor(store: MemoryStore) {
    this.store = store;
  }

  getStore(): MemoryStore {
    return this.store;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  async add(opts: MemoryAddOptions): Promise<MemoryRecord> {
    const record = await this.store.add(opts);
    this.notify();
    return record;
  }

  search(filter: MemorySearchFilter = {}): MemoryRecord[] {
    return this.store.search(filter);
  }

  searchSemantic(filter: MemorySearchFilter = {}): MemorySemanticSearchResult[] {
    return this.store.searchSemantic(filter);
  }

  rebuildVectors(): MemoryVectorStats {
    return this.store.rebuildVectorIndex();
  }

  async rebuildVectorsAsync(): Promise<MemoryVectorStats> {
    return this.store.rebuildVectorIndexAsync();
  }

  vectorStats(): MemoryVectorStats {
    return this.store.vectorStats();
  }

  async doctor(): Promise<MemoryDoctorReport> {
    return this.store.doctor();
  }

  reviewQueue(limit = 10): MemoryRecord[] {
    return this.store.reviewQueue(limit);
  }

  exportBundle(filter: MemorySearchFilter = {}): MemoryBundle {
    return this.store.exportBundle(filter);
  }

  async importBundle(bundle: MemoryBundle): Promise<MemoryImportResult> {
    const result = await this.store.importBundle(bundle);
    this.notify();
    return result;
  }

  get(id: string): MemoryRecord | null {
    return this.store.get(id);
  }

  async link(fromId: string, toId: string, relation: string): Promise<MemoryLink | null> {
    const link = await this.store.link(fromId, toId, relation);
    if (link) this.notify();
    return link;
  }

  linksFor(id: string): MemoryLink[] {
    return this.store.linksFor(id);
  }

  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    const record = this.store.update(id, patch);
    if (record) this.notify();
    return record;
  }

  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    const record = this.store.review(id, patch);
    if (record) this.notify();
    return record;
  }

  delete(id: string): boolean {
    const removed = this.store.delete(id);
    if (removed) this.notify();
    return removed;
  }

  getAll(): MemoryRecord[] {
    return this.store.search({});
  }
}
