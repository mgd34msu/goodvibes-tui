import { beforeEach, describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryAddOptions } from '@pellux/goodvibes-sdk/platform/state';
import { createMemoryApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { ForensicsRegistry } from '@/runtime/index.ts';

interface FakeRecord {
  id: string;
  scope: string;
  cls: string;
  summary: string;
  detail?: string;
  tags: string[];
  provenance: Array<{ kind: string; ref: string }>;
  createdAt: number;
  updatedAt: number;
  reviewState: string;
  confidence: number;
  validFrom?: number;
  validUntil?: number;
}

function makeRegistry(): MemoryRegistry {
  const records: FakeRecord[] = [];
  return {
    add: async (opts: MemoryAddOptions) => {
      const record: FakeRecord = {
        id: `mem-${records.length + 1}`,
        scope: opts.scope ?? 'project',
        cls: opts.cls,
        summary: opts.summary,
        detail: opts.detail,
        tags: opts.tags ?? [],
        provenance: opts.provenance ?? [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reviewState: opts.review?.state ?? 'fresh',
        confidence: opts.review?.confidence ?? 60,
        validFrom: opts.validFrom,
        validUntil: opts.validUntil,
      };
      records.push(record);
      return record as never;
    },
    search: () => records as never,
    honestSearch: () => ({ records, mode: 'literal', requestedSemantic: false, indexUnavailableReason: null, caveat: null, recallFiltered: false, excludedFlaggedCount: 0, excludedBelowFloorCount: 0, totalBeforeRecallFilter: records.length } as never),
    searchSemantic: () => [] as never,
    vectorStats: () => ({ backend: 'sqlite-vec', enabled: true, available: true, dimensions: 1536, indexedRecords: records.length, path: ':memory:' }),
    rebuildVectors: () => ({ backend: 'sqlite-vec', enabled: true, available: true, dimensions: 1536, indexedRecords: records.length, path: ':memory:' }),
    rebuildVectorsAsync: async () => ({ backend: 'sqlite-vec', enabled: true, available: true, dimensions: 1536, indexedRecords: records.length, path: ':memory:' }),
    doctor: async () => ({
      vector: { backend: 'sqlite-vec', enabled: true, available: true, dimensions: 1536, indexedRecords: records.length, path: ':memory:' },
      embeddings: { configured: true, activeProviderId: 'hashed-local', defaultProviderId: 'hashed-local', registeredProviders: [], warnings: [] },
      checkedAt: Date.now(),
    }) as never,
    reviewQueue: (limit = 10) => records.slice(0, limit) as never,
    update: () => null,
    get: (id: string) => records.find((entry) => entry.id === id) as never,
    link: async () => null,
    linksFor: () => [] as never,
    delete: () => false,
    review: () => null,
    exportBundle: () => ({ schemaVersion: 'v1', exportedAt: Date.now(), scope: 'all', recordCount: records.length, linkCount: 0, records: records as never, links: [] } as never),
    importBundle: async () => ({ importedRecords: 0, skippedRecords: 0, importedLinks: 0 }) as never,
    getAll: () => records as never,
  } as unknown as MemoryRegistry;
}

function makeContext(printed: string[], registry: MemoryRegistry): CommandContext {
  return {
    session: { conversationManager: {} as never, runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'session-1' } },
    provider: { providerRegistry: {} as never },
    workspace: { shellPaths: undefined },
    platform: { config: {} as never, configManager: {} as never },
    ops: {},
    extensions: { toolRegistry: {} as never, mcpRegistry: {} as never, memoryRegistry: registry, forensicsRegistry: new ForensicsRegistry() },
    clients: {
      knowledgeApi: { memory: createMemoryApi(registry) } as never,
      memorySpine: new MemorySpineClient({ local: createLocalMemoryAccess(registry as unknown as LocalMemoryStore) }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('temporal-status visibility in /recall listings', () => {
  let printed: string[];
  let registry: MemoryRegistry;
  const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const FAR_PAST = Date.now() - 365 * 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    printed = [];
    registry = makeRegistry();
    await registry.add({ cls: 'decision', summary: 'Always-active record.', scope: 'project' }); // mem-1
    await registry.add({ cls: 'decision', summary: 'Expired record.', scope: 'project', validUntil: FAR_PAST }); // mem-2
    await registry.add({ cls: 'decision', summary: 'Pending record.', scope: 'project', validFrom: FAR_FUTURE }); // mem-3
  });

  test('/recall list labels expired and pending records, leaves an active one unlabelled', async () => {
    await recallCommand.handler(['list'], makeContext(printed, registry));
    const text = printed.join('\n');
    expect(text).toContain('mem-2 [project]');
    expect(text).toContain('Expired record. [expired]');
    expect(text).toContain('Pending record. [pending]');
    expect(text).not.toContain('Always-active record. [active]');
    expect(text).not.toContain('Always-active record. [pending]');
    expect(text).not.toContain('Always-active record. [expired]');
  });

  test('/recall get shows the temporal window and its live status for an expired record', async () => {
    await recallCommand.handler(['get', 'mem-2'], makeContext(printed, registry));
    const text = printed.join('\n');
    expect(text).toContain('Temporal:');
    expect(text).toContain('[expired]');
  });

  test('/recall get omits the Temporal line for a record with no window', async () => {
    await recallCommand.handler(['get', 'mem-1'], makeContext(printed, registry));
    expect(printed.join('\n')).not.toContain('Temporal:');
  });

  test('/recall queue labels a pending record in the review queue listing', async () => {
    await recallCommand.handler(['queue'], makeContext(printed, registry));
    expect(printed.join('\n')).toContain('[pending]');
  });
});
