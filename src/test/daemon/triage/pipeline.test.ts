import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createTriageStore,
  enrichItemsWithTriage,
  readTriageMetadata,
  readTriageMetadataBatch,
  runInboxTriage,
} from '../../../daemon/handlers/triage/pipeline.ts';
import { fakeContext, item, makeTempDir, removeTempDir } from './helpers.ts';

describe('runInboxTriage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('gv-triage-pipeline-');
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  const fixedNow = () => new Date('2026-06-21T00:00:00.000Z');

  it('scores and persists every item, then reads it back', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const items = [
      item({ id: 'a', surface: 'email', subject: 'free lottery winner prize', snippet: 'claim now!!!' }),
      item({ id: 'b', surface: 'slack', subject: 'lunch', snippet: 'tomorrow?' }),
    ];
    const result = await runInboxTriage(items, ctx, { now: fixedNow });
    expect(result.scored).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.items[0]!.triage.triageLabel).toBeDefined();

    const store = createTriageStore(dir);
    await store.init();
    try {
      const meta = readTriageMetadata(store, 'a');
      expect(meta).not.toBeNull();
      expect(meta!.triageTags.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('does not persist in dry-run mode', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const result = await runInboxTriage(
      [item({ id: 'x', surface: 'email', subject: 'hi', snippet: 'there' })],
      ctx,
      { dryRun: true, now: fixedNow },
    );
    expect(result.scored).toBe(1);
    expect(result.persisted).toBe(0);
  });

  it('upserts existing rows on re-score (idempotent by id)', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const store = createTriageStore(dir);
    await store.init();
    try {
      await runInboxTriage(
        [item({ id: 'dup', surface: 'email', subject: 'hello', snippet: 'world' })],
        ctx,
        { store, now: fixedNow },
      );
      await runInboxTriage(
        [item({ id: 'dup', surface: 'email', subject: 'URGENT deadline asap', snippet: 'action required' })],
        ctx,
        { store, now: fixedNow },
      );
      const rows = store.all<{ count: number }>('SELECT COUNT(*) as count FROM inbox_triage');
      expect(rows[0]!.count).toBe(1);
      const meta = readTriageMetadata(store, 'dup');
      expect(meta!.triageLabel).toBe('priority');
    } finally {
      store.close();
    }
  });

  it('returns an empty result for an empty batch without opening a store', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const result = await runInboxTriage([], ctx);
    expect(result).toEqual({ items: [], scored: 0, persisted: 0 });
  });
});

describe('enrichItemsWithTriage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('gv-triage-enrich-');
  });
  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('overlays persisted triage metadata onto matching items and passes others through', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const store = createTriageStore(dir);
    await store.init();
    try {
      await runInboxTriage(
        [item({ id: 'scored', surface: 'email', subject: 'free prize winner', snippet: 'lottery cash!!!' })],
        ctx,
        { store },
      );
      const enriched = enrichItemsWithTriage(store, [
        { id: 'scored', extra: 1 },
        { id: 'unscored', extra: 2 },
      ]);
      const scored = enriched.find((e) => e.id === 'scored')!;
      const unscored = enriched.find((e) => e.id === 'unscored')!;
      expect(scored.triageLabel).toBeDefined();
      expect(Array.isArray(scored.triageTags)).toBe(true);
      expect(unscored.triageLabel).toBeUndefined();
      // original fields are preserved
      expect(scored.extra).toBe(1);
    } finally {
      store.close();
    }
  });

  it('reads many ids in one batched query and de-duplicates', async () => {
    const ctx = fakeContext({ workingDirectory: dir });
    const store = createTriageStore(dir);
    await store.init();
    try {
      await runInboxTriage(
        [
          item({ id: 'p', surface: 'email', subject: 'urgent deadline asap', snippet: 'action required now' }),
          item({ id: 'q', surface: 'email', subject: 'hi', snippet: 'hello' }),
        ],
        ctx,
        { store },
      );
      const map = readTriageMetadataBatch(store, ['p', 'q', 'p', 'missing']);
      expect(map.size).toBe(2);
      expect(map.has('p')).toBe(true);
      expect(map.has('missing')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('returns an empty array for no items', () => {
    const store = createTriageStore(dir);
    expect(enrichItemsWithTriage(store, [])).toEqual([]);
  });
});
