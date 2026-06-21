import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTriageStore,
  readTriageMetadata,
  runInboxTriage,
} from '../../../daemon/triage/pipeline.ts';
import type { OperatorContext, InboundChannelItem } from '../../../daemon/operator/index.ts';

function makeCtx(workingDirectory: string): OperatorContext {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    catalog: {} as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory,
    homeDirectory: workingDirectory,
    logger: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
      error: (msg) => logs.push({ level: 'error', msg }),
    },
  };
}

function item(partial: Partial<InboundChannelItem>): InboundChannelItem {
  return {
    id: partial.id ?? 'i-1',
    surface: partial.surface ?? 'email',
    fromDigest: 'abc',
    messageDigest: 'def',
    receivedAt: '2026-06-20T00:00:00.000Z',
    unread: true,
    ...partial,
  };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-triage-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runInboxTriage', () => {
  test('scores all items and enriches them with triage metadata', async () => {
    const ctx = makeCtx(workDir);
    const items = [
      item({ id: 'a', subject: 'free lottery winner cash', snippet: 'click http://x http://y' }),
      item({ id: 'b', subject: 'lunch?', snippet: 'grab a bite next week' }),
    ];
    const result = await runInboxTriage(items, ctx);
    expect(result.scored).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.items[0]!.triage.triageLabel).toBe('spam');
    expect(result.items[0]!.triage.triageTags).toContain('GoodVibes/Spam');
    expect(result.items[1]!.triage.triageLabel).toBe('normal');
  });

  test('persists triageScore/triageTags readable by readTriageMetadata', async () => {
    const ctx = makeCtx(workDir);
    await runInboxTriage([item({ id: 'persist-me', subject: 'URGENT deadline', snippet: 'asap critical' })], ctx);

    const store = createTriageStore(workDir);
    await store.init();
    try {
      const meta = readTriageMetadata(store, 'persist-me');
      expect(meta).not.toBeNull();
      expect(meta!.triageLabel).toBe('priority');
      expect(meta!.triageScore).toBeGreaterThanOrEqual(0.6);
      expect(Array.isArray(meta!.triageTags)).toBe(true);
      expect(meta!.signals.priority).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test('upserts: re-running updates the same row rather than duplicating', async () => {
    const ctx = makeCtx(workDir);
    await runInboxTriage([item({ id: 'dup', subject: 'hello', snippet: 'world' })], ctx, {
      now: () => new Date('2026-06-20T00:00:00.000Z'),
    });
    await runInboxTriage([item({ id: 'dup', subject: 'URGENT critical emergency', snippet: 'asap' })], ctx, {
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    const store = createTriageStore(workDir);
    await store.init();
    try {
      const rows = store.all('SELECT id, triageLabel, updatedAt FROM inbox_triage WHERE id = ?', ['dup']);
      expect(rows.length).toBe(1);
      expect(rows[0]!.triageLabel).toBe('priority');
      expect(rows[0]!.updatedAt).toBe('2026-06-21T00:00:00.000Z');
    } finally {
      store.close();
    }
  });

  test('dryRun computes scores without persisting', async () => {
    const ctx = makeCtx(workDir);
    const result = await runInboxTriage([item({ id: 'ghost', subject: 'spam free cash', snippet: 'win' })], ctx, {
      dryRun: true,
    });
    expect(result.scored).toBe(1);
    expect(result.persisted).toBe(0);

    const store = createTriageStore(workDir);
    await store.init();
    try {
      expect(readTriageMetadata(store, 'ghost')).toBeNull();
    } finally {
      store.close();
    }
  });

  test('empty input is a no-op', async () => {
    const ctx = makeCtx(workDir);
    const result = await runInboxTriage([], ctx);
    expect(result.scored).toBe(0);
    expect(result.persisted).toBe(0);
    expect(result.items).toEqual([]);
  });

  test('uses an injected store and leaves lifecycle to the caller', async () => {
    const ctx = makeCtx(workDir);
    const store = createTriageStore(workDir);
    await store.init();
    try {
      const result = await runInboxTriage([item({ id: 'inj', subject: 'note', snippet: 'ok' })], ctx, { store });
      expect(result.persisted).toBe(1);
      // Row visible immediately on the same (still-open) store instance.
      expect(readTriageMetadata(store, 'inj')).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
