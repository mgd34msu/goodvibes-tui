import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { recallCommand } from '../../input/commands/memory.ts';
import { MemoryRegistry } from '@pellux/goodvibes-sdk/platform/state';
import type { MemoryAddOptions } from '@pellux/goodvibes-sdk/platform/state';
import { createMemoryApi } from '@pellux/goodvibes-sdk/platform/knowledge';
import { MemorySpineClient, createLocalMemoryAccess, type LocalMemoryStore } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { ForensicsRegistry, createShellPathService } from '@/runtime/index.ts';

// ── A minimal in-memory MemoryRegistry fake, same shape as recall-command.test.ts ──

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
    honestSearch: () => ({
      records,
      mode: 'literal',
      requestedSemantic: false,
      indexUnavailableReason: null,
      caveat: null,
      recallFiltered: false,
      excludedFlaggedCount: 0,
      excludedBelowFloorCount: 0,
      totalBeforeRecallFilter: records.length,
    } as never),
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
    update: (id: string, patch: { scope?: string; summary?: string; detail?: string; tags?: string[]; validFrom?: number | null; validUntil?: number | null }) => {
      const record = records.find((entry) => entry.id === id);
      if (!record) return null;
      if (patch.scope !== undefined) record.scope = patch.scope;
      if (patch.summary !== undefined) record.summary = patch.summary;
      if (patch.detail !== undefined) record.detail = patch.detail;
      if (patch.tags !== undefined) record.tags = patch.tags;
      // null clears the bound, a number sets it, omitted leaves it unchanged —
      // mirrors the real MemoryUpdatePatch/registry semantics.
      if (patch.validFrom !== undefined) record.validFrom = patch.validFrom === null ? undefined : patch.validFrom;
      if (patch.validUntil !== undefined) record.validUntil = patch.validUntil === null ? undefined : patch.validUntil;
      record.updatedAt = Date.now();
      return record as never;
    },
    get: (id: string) => records.find((entry) => entry.id === id) as never,
    link: async () => null,
    linksFor: () => [] as never,
    delete: (id: string) => {
      const index = records.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    },
    review: () => null,
    exportBundle: () => ({ schemaVersion: 'v1', exportedAt: Date.now(), scope: 'all', recordCount: records.length, linkCount: 0, records: records as never, links: [] } as never),
    importBundle: async () => ({ importedRecords: 0, skippedRecords: 0, importedLinks: 0 }) as never,
    getAll: () => records as never,
  } as unknown as MemoryRegistry;
}

function makeContext(printed: string[], registry: MemoryRegistry, workingDirectory: string): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: '', sessionId: 'session-1' },
    },
    provider: { providerRegistry: {} as never },
    workspace: { shellPaths: createShellPathService({ workingDirectory, homeDirectory: workingDirectory }) },
    platform: { config: {} as never, configManager: { get: () => undefined } as never },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      memoryRegistry: registry,
      forensicsRegistry: new ForensicsRegistry(),
    },
    clients: {
      knowledgeApi: { memory: createMemoryApi(registry) } as never,
      memorySpine: new MemorySpineClient({ local: createLocalMemoryAccess(registry as unknown as LocalMemoryStore) }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('/recall files (memory file projection surface)', () => {
  let printed: string[];
  let root: string;
  let registry: MemoryRegistry;
  let dir: string;

  beforeEach(async () => {
    printed = [];
    root = mkdtempSync(join(tmpdir(), 'gv-recall-files-'));
    registry = makeRegistry();
    dir = join(root, 'projection');
    await registry.add({ cls: 'decision', summary: 'Ship dark flags before the review pass.', scope: 'project', tags: ['flags'] });
    await registry.add({ cls: 'constraint', summary: 'Session-scope note, excluded from projection.', scope: 'session' });
  });

  test('sync writes one markdown file per standing (project/team) record, session scope excluded', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('Projected 1 record(s)'))).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const content = readFileSync(join(dir, files[0]!), 'utf-8');
    expect(content).toContain('id: mem-1');
    expect(content).toContain('scope: project');
    expect(content).toContain('# Ship dark flags before the review pass.');
  });

  test('sync outside a git repository reports it was not committed, honestly', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('not committed: ') && l.includes('not inside a git repository'))).toBe(true);
  });

  test('sync inside a git repository commits the projection directory', async () => {
    Bun.spawnSync(['git', 'init'], { cwd: root });
    Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: root });
    Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: root });

    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('committed in'))).toBe(true);

    const log = Bun.spawnSync(['git', 'log', '--oneline'], { cwd: root });
    expect(new TextDecoder().decode(log.stdout)).toContain('memory projection');
  });

  test('review reports no changes right after a sync', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    printed.length = 0;
    await recallCommand.handler(['files', 'review', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('No changes'))).toBe(true);
  });

  test('review is read-only: an edited file produces an update proposal without mutating the store', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    const file = join(dir, readdirSync(dir)[0]!);
    const edited = readFileSync(file, 'utf-8').replace('Ship dark flags before the review pass.', 'Ship dark flags before the review pass (edited).');
    writeFileSync(file, edited, 'utf-8');

    printed.length = 0;
    await recallCommand.handler(['files', 'review', '--dir', dir], makeContext(printed, registry, root));
    const text = printed.join('\n');
    expect(text).toContain('mem-1 [update]');
    expect(text).toContain('Nothing has been applied');

    // Store must be untouched — review never writes.
    const record = registry.get('mem-1') as unknown as FakeRecord;
    expect(record.summary).toBe('Ship dark flags before the review pass.');
  });

  test('apply mutates the store only for the confirmed id', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    const file = join(dir, readdirSync(dir)[0]!);
    writeFileSync(file, readFileSync(file, 'utf-8').replace('Ship dark flags before the review pass.', 'Renamed summary.'), 'utf-8');

    printed.length = 0;
    await recallCommand.handler(['files', 'apply', 'mem-1', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('Applied 1, skipped 0, failed 0'))).toBe(true);

    const record = registry.get('mem-1') as unknown as FakeRecord;
    expect(record.summary).toBe('Renamed summary.');
  });

  test('apply with no matching proposal id applies nothing', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    printed.length = 0;
    await recallCommand.handler(['files', 'apply', 'mem-does-not-exist', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('No matching proposals'))).toBe(true);
  });

  test('a deleted projection file proposes (and, on apply, performs) a store delete', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    const file = join(dir, readdirSync(dir)[0]!);
    rmSync(file);

    printed.length = 0;
    await recallCommand.handler(['files', 'review', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.join('\n')).toContain('mem-1 [delete]');

    printed.length = 0;
    await recallCommand.handler(['files', 'apply', '--all', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('applied  mem-1 [delete]'))).toBe(true);
    expect(registry.get('mem-1')).toBeUndefined();
  });

  test('a temporal-window-only edit applies for real: review proposes it, apply sets validUntil on the record', async () => {
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));
    const file = join(dir, readdirSync(dir)[0]!);
    const withValidUntil = readFileSync(file, 'utf-8').replace('status: active', 'validUntil: 2099-01-01T00:00:00.000Z\nstatus: active');
    writeFileSync(file, withValidUntil, 'utf-8');

    printed.length = 0;
    await recallCommand.handler(['files', 'review', '--dir', dir], makeContext(printed, registry, root));
    const reviewText = printed.join('\n');
    expect(reviewText).toContain('mem-1 [update]');
    expect(reviewText).toContain('changed: validUntil');

    printed.length = 0;
    await recallCommand.handler(['files', 'apply', 'mem-1', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('Applied 1, skipped 0, failed 0'))).toBe(true);
    expect(printed.some((l) => l.includes('applied  mem-1 [update]'))).toBe(true);

    const record = registry.get('mem-1') as unknown as FakeRecord;
    expect(record.validUntil).toBe(Date.parse('2099-01-01T00:00:00.000Z'));
  });

  test('clearing a temporal bound in the projected file applies as a real clear (null), not a no-op', async () => {
    await registry.add({ cls: 'decision', summary: 'Time-boxed note.', scope: 'project', tags: [], validUntil: Date.parse('2099-01-01T00:00:00.000Z') } as never);
    printed.length = 0;
    await recallCommand.handler(['files', 'sync', '--dir', dir], makeContext(printed, registry, root));

    const files = readdirSync(dir);
    const file = files.map((f) => join(dir, f)).find((f) => readFileSync(f, 'utf-8').includes('id: mem-3'))!;
    const cleared = readFileSync(file, 'utf-8').split('\n').filter((line) => !line.startsWith('validUntil:')).join('\n');
    writeFileSync(file, cleared, 'utf-8');

    printed.length = 0;
    await recallCommand.handler(['files', 'apply', 'mem-3', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('Applied 1, skipped 0, failed 0'))).toBe(true);

    const record = registry.get('mem-3') as unknown as FakeRecord;
    expect(record.validUntil).toBeUndefined();
  });

  test('files review with no projection directory yet points at files sync, applies nothing', async () => {
    await recallCommand.handler(['files', 'review', '--dir', dir], makeContext(printed, registry, root));
    expect(printed.some((l) => l.includes('Run /recall files sync first'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
});
