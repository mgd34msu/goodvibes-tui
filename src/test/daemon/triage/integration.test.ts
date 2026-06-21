import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTriagedInbox } from '../../../daemon/triage/integration.ts';
import { TRIAGE_METHOD_IDS } from '../../../daemon/triage/register.ts';
import {
  createTriageStore,
  enrichItemsWithTriage,
  runInboxTriage,
} from '../../../daemon/triage/pipeline.ts';
import { INBOX_LIST_METHOD_ID } from '../../../daemon/channels/inbox/index.ts';
import { InboxCursorStore } from '../../../daemon/channels/inbox/cursor-store.ts';
import type { OperatorContext, InboundChannelItem } from '../../../daemon/operator/index.ts';

// ---------------------------------------------------------------------------
// Minimal in-memory catalog mirroring the GatewayMethodCatalog surface used by
// declareOperatorMethod and by the inbox surface (register/invoke/get/list).
// This is the SAME shape services.ts injects as ctx.catalog, so exercising it
// here proves the surface is registered + invokable through the real wiring
// call (registerTriagedInbox) rather than via test-only glue.
// ---------------------------------------------------------------------------

interface CatalogEntry {
  descriptor: Record<string, unknown>;
  handler: (input: {
    body: unknown;
    context: { principalId?: string; metadata?: Record<string, unknown> };
  }) => Promise<unknown>;
}

function makeCatalog() {
  const entries = new Map<string, CatalogEntry>();
  return {
    register(descriptor: Record<string, unknown>, handler: CatalogEntry['handler']) {
      const id = descriptor.id as string;
      entries.set(id, { descriptor, handler });
      return () => {
        entries.delete(id);
      };
    },
    async invoke(
      id: string,
      input: { body: unknown; context: { principalId?: string; metadata?: Record<string, unknown> } },
    ) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`no such method: ${id}`);
      return entry.handler(input);
    },
    list() {
      return [...entries.values()].map((e) => e.descriptor);
    },
    get(id: string) {
      return entries.get(id)?.descriptor ?? null;
    },
    has(id: string) {
      return entries.has(id);
    },
  };
}

let workDir: string;
let catalog: ReturnType<typeof makeCatalog>;

function makeCtx(): OperatorContext {
  return {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: {} as OperatorContext['secrets'],
    configManager: { get: () => undefined, getCategory: () => ({}) } as unknown as OperatorContext['configManager'],
    workingDirectory: workDir,
    homeDirectory: workDir,
    logger: { info() {}, warn() {}, error() {} },
  };
}

function triageItem(partial: Partial<InboundChannelItem>): InboundChannelItem {
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

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gv-triage-int-'));
  catalog = makeCatalog();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('registerTriagedInbox wiring (the call services.ts makes)', () => {
  test('registers the triage methods AND channels.inbox.list, and tears all down', () => {
    const unregister = registerTriagedInbox(makeCtx(), {
      inbox: { skipInitialPoll: true, registerBuiltins: false },
    });

    const ids = catalog.list().map((d) => d.id);
    expect(ids).toContain(TRIAGE_METHOD_IDS.list);
    expect(ids).toContain(TRIAGE_METHOD_IDS.tag);
    expect(ids).toContain(INBOX_LIST_METHOD_ID);

    unregister();
    expect(catalog.has(TRIAGE_METHOD_IDS.list)).toBe(false);
    expect(catalog.has(TRIAGE_METHOD_IDS.tag)).toBe(false);
    expect(catalog.has(INBOX_LIST_METHOD_ID)).toBe(false);
  });

  test('channels.inbox.list keeps transport ["ws","internal"]; triage methods stay internal-only', () => {
    registerTriagedInbox(makeCtx(), { inbox: { skipInitialPoll: true, registerBuiltins: false } });
    expect(catalog.get(INBOX_LIST_METHOD_ID)!.transport).toEqual(['ws', 'internal']);
    expect(catalog.get(TRIAGE_METHOD_IDS.list)!.transport).toEqual(['internal']);
    expect(catalog.get(TRIAGE_METHOD_IDS.tag)!.transport).toEqual(['internal']);
  });
});

describe('channels.inbox.list -> readTriageMetadata contract path', () => {
  test('items returned by channels.inbox.list are overlaid with persisted triage scores', async () => {
    // 1. The poller path: score + persist inbound items into inbox-triage.sqlite.
    await runInboxTriage(
      [
        triageItem({ id: 'm-spam', subject: 'free lottery winner', snippet: 'cash prize http://x http://y' }),
        triageItem({ id: 'm-norm', subject: 'lunch', snippet: 'grab a bite next week?' }),
      ],
      makeCtx(),
    );

    // 2. The inbox feed: seed the authoritative cursor store on disk (default
    //    file name) with the SAME ids the poller scored. triage columns are NULL
    //    here — the contract requires the list path to read them from triage.
    const inbox = new InboxCursorStore(workDir);
    await inbox.init();
    inbox.upsertItems([
      {
        id: 'm-spam',
        provider: 'email',
        kind: 'dm',
        fromDigest: 'aa',
        subjectPreview: 'free lottery winner',
        bodyPreview: 'cash prize',
        receivedAt: 1_700_000_000,
        unread: true,
      },
      {
        id: 'm-norm',
        provider: 'email',
        kind: 'dm',
        fromDigest: 'bb',
        subjectPreview: 'lunch',
        bodyPreview: 'next week',
        receivedAt: 1_700_000_100,
        unread: true,
      },
    ] as unknown as Parameters<InboxCursorStore['upsertItems']>[0]);
    await inbox.close();

    // 3. Register through the composition root and invoke the read method.
    registerTriagedInbox(makeCtx(), { inbox: { skipInitialPoll: true, registerBuiltins: false } });
    const result = (await catalog.invoke(INBOX_LIST_METHOD_ID, {
      body: {},
      context: { principalId: 'agent' },
    })) as {
      items: Array<{ id: string; triageScore?: number; triageTags?: string[]; triageLabel?: string }>;
    };

    const byId = new Map(result.items.map((i) => [i.id, i]));
    expect(byId.size).toBe(2);

    const spam = byId.get('m-spam')!;
    expect(spam.triageScore).toBeGreaterThan(0);
    expect(spam.triageLabel).toBe('spam');
    expect(spam.triageTags).toContain('GoodVibes/Spam');

    const norm = byId.get('m-norm')!;
    expect(norm.triageLabel).toBe('normal');
  });

  test('enrichItemsWithTriage leaves un-scored items untouched', async () => {
    await runInboxTriage([triageItem({ id: 'scored', subject: 'URGENT deadline', snippet: 'asap critical' })], makeCtx());

    const store = createTriageStore(workDir);
    await store.init();
    try {
      const enriched = enrichItemsWithTriage(store, [
        { id: 'scored' },
        { id: 'never-seen' },
      ]);
      const scored = enriched.find((e) => e.id === 'scored')!;
      const missing = enriched.find((e) => e.id === 'never-seen')!;
      expect(scored.triageScore).toBeGreaterThan(0);
      expect(scored.triageLabel).toBe('priority');
      expect(missing.triageScore).toBeUndefined();
      expect(missing.triageTags).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
